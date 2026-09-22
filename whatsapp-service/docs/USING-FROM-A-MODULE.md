# Using the WhatsApp Service from a ScaleEzy module

For the CRM, Marketing, Billing, or any new module. Read [HOW-IT-WORKS.md](HOW-IT-WORKS.md) first
(the two kinds of number, and what shops and their customers see).

Inventory is the worked example, in the Inventory backend repo:
- `src/services/whatsapp/client.ts`: the only file that calls this service.
- `service.ts`: the rules (who may send what, to whom).
- `src/routes/whatsapp.routes.ts`: the buttons' routes and the events webhook.
- `src/scripts/verify-whatsapp.ts`: the tests, against a fake service.

Copy its shape.

## The rules your module must keep

1. **Pick the right number.** Ask one question: *is ScaleEzy talking to the shop, or is the shop
   talking to its own customer or supplier?*
   - ScaleEzy talking to the shop (owners and staff): `from: "scaleezy"` (needs the
     `--can-send-as-scaleezy` permission).
   - The shop talking to its own customers or suppliers: `from: { clientId }`.

   Never send to a shop's customer from ScaleEzy's number.
2. **A person presses Send.** Messages to a shop's customers or suppliers go only on a button
   press, one message per press. The only automatic messages are ScaleEzy's own ones to a shop
   owner who switched them on (like the Day Book).
3. **No bulk.** Linked numbers are banned for bulk sending. The service spaces messages 4–9 s
   apart and caps each number per day:
   - 40 a day for a shop number's first 14 days, then 200.
   - ScaleEzy's number: `SCALEEZY_DAILY_CAP` (150).

   A campaign to hundreds of customers does not belong here. It needs the official WhatsApp
   Cloud API (planned).
4. **Your server decides the recipient**, from your own records (the order's customer, the
   invoice's contact). Never send to a phone number that came from the browser.
5. **One link per shop, shared by every module.** The shop links its number once (today in
   Inventory's Settings → WhatsApp). Your module uses the same `clientId` and sends from that
   link.
   - If your module has a link screen, call the same link API. It reuses the shop's link and
     never makes a second one.
   - Never link a shop's number any other way (your own Baileys, another tool). A second tool
     has its own queue, so the daily limits and the STOP list no longer protect the shop: that
     is how numbers get banned and people who said STOP get messaged.
6. **`clientId` is the ScaleEzy platform client id**, the same one Inventory uses (e.g. `sphl`).
   A different id for the same shop would look like a second shop with no link.
7. Keep at most the **last four digits** of a number in your logs. Keep full numbers only where
   your module already stores the contact.

## Which message is which (`kind`)

`S` = from ScaleEzy's number to a client. `C` = from a shop's number to its customer or supplier.
Add new kinds to `service/src/http/schemas.ts` (and this table) before using them.

| Kind | Message | Who sends it | Status |
|---|---|---|---|
| S1 | Welcome to ScaleEzy + how to sign in | Platform (gateway) | planned |
| S2 | Team member login details | Inventory, owner presses Send | planned |
| S3 | Password changed / signed out everywhere | Platform | planned |
| S4 | Your shop's WhatsApp is disconnected | Inventory, automatically | **built** |
| S5 | Daily low stock summary (owner switches on) | Inventory | planned |
| S6 | Nightly Day Book PDF (owner switches on) | Inventory | **built** |
| S7 | Reply to a support ticket | Support | planned |
| S8 | Billing / plan notices, invoice PDF | **Billing module** | planned |
| C1 | Purchase order PDF to a supplier | Inventory | **built** |
| C2 | Bill / receipt PDF to a customer | Inventory | **built** |
| C3 | Goods receipt PDF to a supplier | Inventory | **built** |
| C4 | Order update (confirmed / sent) | Inventory or **CRM** | planned |
| C5 | Return / refund note PDF | Inventory | **built** |
| C6 | Payment reminder | **CRM** or **Billing** | planned |
| C7 | Single-use offer code | **Marketing** | planned |
| C8 | Campaign message to customers who agreed to offers (fed a few at a time, 10 am-8 pm, at most half the number's daily cap) | Inventory | **built** |
| C9 | Loyalty notice: points earned after a sale (owner switches on) | Inventory | **built** |
| TEST | "Your WhatsApp is linked" test | any | built |

## Building a WhatsApp feature: step by step

The example: the **CRM** adds **Send payment reminder** (C6) on an unpaid invoice, from the
shop's own number.

### Step 1. Get your module's key (once)

Run it on the service: `npm run module:create` locally, or in the Render Shell of `whatsapp-service`:

```
node dist/scripts/create-module.js --name crm --webhook-url https://<crm-backend>/api/v1/whatsapp/events
# add --can-send-as-scaleezy only if the module sends ScaleEzy's own (S) messages
```

It prints these **once** (only a hash of the key is stored):

```
WHATSAPP_SERVICE_KEY=...      # your module's key
WHATSAPP_WEBHOOK_SECRET=...   # signs every event sent to your webhook
```

Put them in your module's secret settings, along with `WHATSAPP_SERVICE_URL`
(`https://<whatsapp-service>.onrender.com`). Never put them in git.
- **Change the key** with `--rotate-key`. The old key stops working at once.
- **Change the webhook address** with `--rotate-key --webhook-url <new address>`. This also gives
  a new key and a new webhook secret, so update all three settings together.

### Step 2. One client file that does all the talking

Copy Inventory's `client.ts`. The parts that matter:

```ts
async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  if (!env.WHATSAPP_SERVICE_URL || !env.WHATSAPP_SERVICE_KEY) throw new WhatsAppError(503, 'WhatsApp is not set up yet.');
  let res: Response;
  try {
    res = await fetch(`${env.WHATSAPP_SERVICE_URL}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-module-key': env.WHATSAPP_SERVICE_KEY },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs), // sends: 60 s (PDF upload), link: 60 s (QR takes ~20 s)
    });
  } catch {
    throw new WhatsAppError(503, 'WhatsApp could not be reached just now. Please try again in a minute.');
  }
  const json = await res.json().catch(() => null);
  if (res.status === 401) throw new WhatsAppError(503, 'WhatsApp is not set up yet.'); // our key: our problem
  // Errors are { error: { code, message } }. The message is one plain sentence: show it as it is.
  if (!res.ok) throw new WhatsAppError(res.status >= 500 ? 503 : res.status, json?.error?.message ?? 'WhatsApp could not be reached just now.');
  return json as T;
}
```

The service being down must become one polite sentence on the screen, never a crash. Your
module must also run normally with the three settings missing.

### Step 3. The send route: decide everything on the server

```ts
// POST /api/v1/invoices/:id/whatsapp-reminder   body: { nonce }
export async function sendReminder(actor: Actor, invoiceId: string, nonce: string) {
  requirePermission(actor, 'invoice:remind');                 // your module's own permission
  const inv = await db.invoice.findFirst({ where: { id: invoiceId, clientId: actor.clientId } });
  if (!inv) throw notFound('No such invoice.');
  if (inv.status !== 'UNPAID') throw badRequest('This invoice is already paid.');
  const to = inv.customer.phone;                              // from YOUR records, never the browser
  if (!to) throw badRequest('This customer has no phone number. Add one first.');

  const sent = await whatsapp.send({
    from: { clientId: actor.clientId },                       // the shop's own number
    to,
    text: `Hello ${inv.customer.name}, a reminder that invoice ${inv.number} for ₹${inv.due} is due.`,
    kind: 'C6',
    reference: `INVOICE:${inv.id}`,                           // comes back in every status event
    idempotencyKey: `REMIND:${inv.id}:${nonce}`,              // one per button press
  });
  // Keep your own row so the button can show the status, and events can update it.
  await db.whatsappMessage.upsert({
    where: { serviceMessageId: sent.id },
    create: { serviceMessageId: sent.id, clientId: actor.clientId, reference: `INVOICE:${inv.id}`, status: sent.status, toLast4: to.slice(-4), sentBy: actor.id },
    update: {},
  });
  return sent;
}
```

- **`idempotencyKey` is what stops double sends.** The same key always means the same message,
  however often it is retried.
  - The screen makes one `nonce` (a random id) **per button press** and reuses it if that press
    is retried.
  - "Send again" on purpose is a new press, so it gets a new nonce.
  - Scheduled sends use the thing and the day, e.g. `DAY_BOOK:<clientId>:2026-09-18`, so a
    restart cannot send it twice.
- **Documents:** `document: { fileName, mimeType: 'application/pdf', base64 }`. PDF only (the
  file must start with `%PDF-`), at most 5 MB.
  - Inventory's screens make the PDF and upload it; its server checks it before passing it on.
  - Its nightly Day Book is made on the server.
- The service **refuses with a sentence** in these cases:
  - the shop is not linked;
  - the number is not valid;
  - the person replied STOP;
  - the file is not a PDF, or is over 5 MB;
  - your module may not send as ScaleEzy.

  The same document to the same person within 60 s returns the earlier message instead, with
  `duplicate: true`.

### Step 4. The events webhook: ticks, drops, STOPs

The service POSTs to your `--webhook-url`:

```
x-event-id: <uuid>    x-event-type: message.status    x-signature: sha256=<hex HMAC-SHA256 of the raw body>
{ "id": "<uuid>", "type": "message.status", "occurredAt": "...", "data": { ... } }
```

```ts
// Mounted with a RAW body parser, BEFORE your login middleware and rate limiter.
router.post('/whatsapp/events', express.raw({ type: 'application/json', limit: '100kb' }), async (req, res) => {
  const expected = `sha256=${crypto.createHmac('sha256', env.WHATSAPP_WEBHOOK_SECRET).update(req.body).digest('hex')}`;
  const got = String(req.header('x-signature') ?? '');
  if (expected.length !== got.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got))) return res.status(401).end();
  const event = JSON.parse(req.body.toString('utf8'));
  // At least once: the same event can arrive twice. Remember each id (primary key) and skip repeats.
  const fresh = await db.whatsappEventSeen.createMany({ data: [{ id: event.id }], skipDuplicates: true });
  if (fresh.count > 0) await handle(event);
  res.status(204).end();                                       // answer fast; do slow work after
});
```

| Event | `data` | What to do |
|---|---|---|
| `message.status` | `messageId, reference, kind, status, failReason, sentAt, deliveredAt, readAt, failedAt` | Update your row. **Only ever move forward** (`QUEUED < SENDING < SENT < DELIVERED < READ`; `FAILED`/`EXPIRED` are final): ticks arrive out of order |
| `account.connected` / `account.disconnected` / `account.status` | `accountId, kind (SCALEEZY/CLIENT), clientId, status, previousStatus, phone (masked), at` | Show it on your screens. Inventory already tells the owner (email + S4), so **don't send a second warning** |
| `contact.opted_out` | `accountId, clientId, kind, contact (full digits), at` | Mark that contact "no WhatsApp" in your records, if you keep contacts |

`account.*` and `contact.opted_out` go to every module with a webhook. `message.status` goes
only to the module that sent that message.
- A non-2xx answer or a timeout is tried again after 10 s, then 60 s, then recorded as failed.
- Keep event ids for 7 days, then delete them. Inventory's housekeeping does this.

### Step 5. The button on the screen

- **Show the button only to people allowed to send** (your permission), and ask the service for
  status only then.
- **One press = one send.** Disable the button while it is sending, and make a new `nonce` for
  each press.
- **Show where it has got to:** Waiting / Sent / Delivered / Read / Failed, with `failReason` or
  `waitingReason`. Read `GET /v1/messages/:id` (or your own row). Poll every few seconds only
  while it is not finished.
  - Messages to your *own* number never show Delivered (WhatsApp does not tick them).
- **Title the button with who gets it**, e.g. *Send to Ravi Kumar (••••2338)*, so nobody sends to
  the wrong person.
- **Not linked?** Fall back to *Share on WhatsApp* (the phone's share menu, or a `wa.me` link).
  Point the owner to Settings → WhatsApp.

### Step 6. Test it

1. **Against a fake service first.** Copy `src/scripts/verify-whatsapp.ts`: it starts a stub
   service in-process and checks the error shapes, the webhook signature, repeats, forward-only
   status and permissions. Add your own worst cases:
   - a double press;
   - two people pressing at once;
   - a paid invoice;
   - a customer with no phone;
   - the service down;
   - a forged signature;
   - an event arriving twice;
   - READ arriving before DELIVERED.
2. **Then the local engine** (`whatsapp-service/engine/docker-compose.local.yml` and
   `npm run dev` in `service/`), sending **only to your own test numbers**. Never message a real
   customer from a test.
3. **Through the screen**, not just the API. Press the real button and watch the status change.

### Step 7. Go live

- [ ] Module key created on the production service (Step 1); the three settings set on your
      module's Render service.
- [ ] The webhook address is reachable from the service and **not** behind your login or rate
      limiter.
- [ ] `service/src/auth/allow.ts` decides which modules may act for which shops.
      **Today every active module may act for every client.** When the second module joins,
      add the real rule there (e.g. only shops that subscribe to that module, from the gateway).
- [ ] New `kind` added to `schemas.ts` and the table above, if you needed one.
- [ ] A Help Center page (all 5 languages) for the new button.
- [ ] After deploying, `npm run smoke` against the service passes.

## API reference

Every call sends `x-module-key: <WHATSAPP_SERVICE_KEY>`. Bodies are JSON. Errors come back as
`{ "error": { "code": "...", "message": "<one plain sentence>" } }`.

| Call | What for |
|---|---|
| `GET  /v1/accounts/client/:clientId` | Is this shop's number linked? `{ status, phone (masked), linkedAt, lastSeenAt }`. `status`: `NOT_LINKED`, `LINKING`, `CONNECTED`, `DISCONNECTED`, `LOGGED_OUT`. |
| `POST /v1/accounts/client/:clientId/link` | `{ "method": "qr" }` → `{ status, qr }`. The QR is a data-URL image that lasts about 20 s, so ask again every ~18 s while showing it. `{ "method": "code", "phone": "91…" }` → `{ status, pairingCode }`. A connected number is left alone: `{ status: "CONNECTED" }`. |
| `POST /v1/accounts/client/:clientId/disconnect` | Unlink the shop's number (for every module). Ask the person to confirm first. |
| `POST /v1/messages` | Send. `202 { id, status }`, or the existing message with `duplicate: true`. |
| `GET  /v1/messages/:id` | Status, times, `failReason`, and `waitingFor` (`link` / `daily_limit`) with `waitingReason` while queued. Only your module's messages. |
| `POST /v1/numbers/check` | `{ from, to }` → `{ onWhatsApp }` (cached 7 days). Not needed before a send; the service checks by itself. |

Send body:

```json
{
  "from": { "clientId": "lakshmi-silks" },
  "to": "919848022338",
  "text": "Your bill SO-000123 is attached.",
  "document": { "fileName": "Bill-SO-000123.pdf", "mimeType": "application/pdf", "base64": "<PDF>" },
  "kind": "C2",
  "reference": "BILL:<your id>",
  "idempotencyKey": "BILL:<your id>:<one id per button press>"
}
```

- `from` is `{ "clientId": ... }` for a shop's number, or `"scaleezy"` for ScaleEzy's own.
- `to` is digits with the country code. A 10-digit number is taken as Indian (+91).

Statuses go `QUEUED → SENDING → SENT → DELIVERED → READ`, or end at `FAILED` / `EXPIRED` with a
`failReason`. They never go backwards. Anything not sent within 24 h is `EXPIRED`, never sent
late.
