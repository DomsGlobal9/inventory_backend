# Using the WhatsApp Service from a ScaleEzy module

For the CRM, Marketing, Billing, or any new module. Inventory is the worked example:
`src/services/whatsapp/` in this same repo (`client.ts` is the only file that calls this service,
`service.ts` holds the rules, `src/routes/whatsapp.routes.ts` receives the events).

## What the service does, and what your module must not do

- The service owns every WhatsApp number: **ScaleEzy's own** (8142424642) and **each shop's own**,
  linked once by QR or code. A shop links its number **once** and every module can send from it.
  Never link a shop's number from your module a second way: one number, one link, or they kick
  each other off.
- **ScaleEzy's number talks only to ScaleEzy's clients** (owners and their staff): logins,
  "your WhatsApp is disconnected", the nightly Day Book. **A shop's number talks only to that
  shop's customers and suppliers**, on a button press. Never send to a shop's customer from
  ScaleEzy's number.
- **No bulk.** Linked (QR) numbers get banned for bulk sending. The service spaces sends 4–9 s
  apart and caps each number per day (40/day for a number's first 14 days, then 200; ScaleEzy's
  own number: `SCALEEZY_DAILY_CAP`). A campaign to hundreds of customers is not what this is for.
- **Decide the recipient on your server**, from your own records (the order's customer, the PO's
  supplier). Never take a phone number from the browser for a document.
- Keep at most the **last four digits** of a number in your own tables and logs.

## 1. Get a key for your module

On the service (locally `npm run module:create`, on Render `node dist/scripts/create-module.js`):

```
node dist/scripts/create-module.js --name crm --webhook-url https://<your-module>/api/v1/whatsapp/events
# add --can-send-as-scaleezy only if the module sends ScaleEzy's own messages to clients
```

It prints, **once**:

```
WHATSAPP_SERVICE_KEY=...      # your module's key (only its sha256 is stored)
WHATSAPP_WEBHOOK_SECRET=...   # signs every event sent to your webhook
```

Put them, plus `WHATSAPP_SERVICE_URL` (the service's private address on Render), in your module's
secret settings. Rotate with `--rotate-key` (the old key stops working at once).

## 2. Call the API

Every call sends the header `x-module-key: <WHATSAPP_SERVICE_KEY>`. Bodies are JSON. Errors come
back as `{ "error": { "code": "...", "message": "<one plain sentence>" } }` — pass `error.message` to the person as it is.

| Call | What for |
|---|---|
| `GET  /v1/accounts/client/:clientId` | Is this shop's number linked? `{ status, phone (masked), linkedAt, lastSeenAt }`. `status`: `NOT_LINKED`, `LINKING`, `CONNECTED`, `DISCONNECTED`, `LOGGED_OUT`. |
| `POST /v1/accounts/client/:clientId/link` | `{ "method": "qr" }` → `{ status, qr }` (a data-URL image, ~20 s life: ask again every ~18 s while showing it). `{ "method": "code", "phone": "91…" }` → `{ status, pairingCode }`. |
| `POST /v1/accounts/client/:clientId/disconnect` | Unlink the shop's number. |
| `POST /v1/messages` | Send. `202 { id, status }`, or the existing message with `duplicate: true`. |
| `GET  /v1/messages/:id` | Where it has got to, plus `waitingFor` / `waitingReason` while queued. |
| `POST /v1/numbers/check` | `{ from, to }` → `{ onWhatsApp }` (cached 7 days). |

### Sending

```json
{
  "from": { "clientId": "lakshmi-silks" },      // or "scaleezy" (needs --can-send-as-scaleezy)
  "to": "919848022338",                          // digits with country code
  "text": "Your bill SO-000123 is attached.",
  "document": { "fileName": "Bill-SO-000123.pdf", "mimeType": "application/pdf", "base64": "<PDF>" },
  "kind": "C2",
  "reference": "BILL:<your id>",
  "idempotencyKey": "BILL:<your id>:<one id per button press>"
}
```

- `kind`: `S1`…`S8` are ScaleEzy's own messages (S4 = WhatsApp disconnected, S6 = nightly Day
  Book), `C1`…`C7` a shop's (C1 purchase order, C2 bill, C3 goods receipt, C5 return note), `TEST`.
- `idempotencyKey` is the one rule that stops double sends: **the same key is always the same
  message**, however often it is retried. Use one per button press (a retry of that press reuses
  it; a deliberate "send again" gets a new one). For scheduled sends use the thing and the day,
  e.g. `DAY_BOOK:<clientId>:2026-09-18`, so a restart cannot send twice.
- Refused, with a sentence: shop not linked, not a valid number, the person replied STOP, not a
  PDF or over 5 MB, the same document to the same person within 60 s (the earlier message comes
  back instead), ScaleEzy sending without permission.
- Statuses: `QUEUED → SENDING → SENT → DELIVERED → READ`, or `FAILED` / `EXPIRED` with
  `failReason`. Never backwards. Anything not sent within 24 h is `EXPIRED`, never sent late.
  Messages to your own number never get `DELIVERED` (WhatsApp does not tick them).

## 3. Receive events

The service POSTs events to your `--webhook-url`:

```
x-event-id: <uuid>          x-event-type: message.status
x-signature: sha256=<hex HMAC-SHA256 of the raw body, key = WHATSAPP_WEBHOOK_SECRET>
{ "id": "<uuid>", "type": "message.status", "occurredAt": "...", "data": { ... } }
```

1. **Verify the signature over the raw bytes** before parsing (constant-time compare). Mount the
   route on a raw body parser and ahead of any login gate.
2. **Handle each `id` once** — delivery is at least once. Inventory writes the id to a table with a
   primary key and ignores a repeat.
3. Answer 2xx quickly. A non-2xx or timeout is retried after 10 s, then 60 s, then recorded failed.
4. Never move a status backwards: ticks can arrive out of order.

| Event | `data` |
|---|---|
| `message.status` | `messageId, reference, kind, status, failReason, sentAt, deliveredAt, readAt, failedAt` |
| `account.connected` / `account.disconnected` / `account.status` | `accountId, kind (SCALEEZY/CLIENT), clientId, status, previousStatus, phone (masked), at` |
| `contact.opted_out` | `accountId, clientId, kind, contact (full digits — store only what you need), at` |

`account.*` and `contact.opted_out` go to every module with a webhook; `message.status` only to
the module that sent the message.

## 4. Before you ship

- Which modules may act for which shops is `service/src/auth/allow.ts`. Today every active module
  may act for every client; **add the real rule when a second module joins** (e.g. only shops
  subscribed to that module).
- Test against a fake service first (Inventory's `src/scripts/verify-whatsapp.ts` starts
  one in-process), then against the local engine sending **only to your own test numbers**.
- Screens: fall back to the old click-to-chat (`wa.me`) when the shop is not linked, show the
  status and `waitingReason` next to the button, and one press = one send.
