# How ScaleEzy WhatsApp works

Plain-English overview for everyone: ScaleEzy staff, module developers, support. The API details
for developers are in [USING-FROM-A-MODULE.md](USING-FROM-A-MODULE.md).

## The picture

```
                         ┌────────────────────────────────────┐
  Inventory ──┐          │      ScaleEzy WhatsApp Service      │
  CRM ────────┼── key ──▶│  queue · limits · STOP list · logs  │──▶ WhatsApp engine ──▶ WhatsApp
  Billing ────┘          └────────────────────────────────────┘      (private)
      ▲                                  │
      └──────── ticks, drops, STOPs ─────┘  (signed events back to each module)
```

- **One service owns every WhatsApp number** ScaleEzy uses. Modules (Inventory today; CRM,
  Marketing, Billing later) never talk to WhatsApp themselves. They ask the service to send.
- The service keeps the queue, spaces messages out, counts daily limits, remembers who said
  STOP, and reports back "sent / delivered / read".
- The engine (Evolution API, which drives WhatsApp's "Linked devices") sits on Render's private
  network. Nobody on the internet can reach it.

## Two kinds of number, never mixed

| | **ScaleEzy's own number** (8142424642) | **A shop's own number** |
|---|---|---|
| Who owns it | ScaleEzy | Each client (shop) |
| Who it messages | **Only ScaleEzy's clients**: shop owners and their staff | **Only that shop's own customers and suppliers** |
| What it sends | Things from ScaleEzy to the shop: WhatsApp disconnected warning, nightly Day Book, later logins, low stock, support replies, plan notices | The shop's documents: purchase orders, bills, goods receipts, return notes, later order updates and payment reminders |
| When | Automatic, but only what the owner switched on (for example the Day Book at 10 pm) | **Only when a person presses Send**. Never automatic to customers, never bulk |
| Linked by | ScaleEzy, once, after a deploy (`npm run link:scaleezy`) | The shop owner, once, in **Settings → WhatsApp** (scan a QR or type a code) |
| Replies go to | The ScaleEzy phone | The shop's own phone |

**The golden rule:** a shop's customer never gets a message from ScaleEzy's number, and
ScaleEzy never sends from a shop's number. Each person hears only from the business they know.

## Journey 1: ScaleEzy talking to a client (the shop owner)

Example: the nightly Day Book.

1. The owner opens **Settings → WhatsApp → Nightly Day Book**, switches it on, checks their
   number and picks a time (10:00 pm by default). Only the owner can change this.
2. At that time Inventory makes the Day Book PDF on its server and asks the service to send it
   **from ScaleEzy's number** to the owner.
3. The owner gets it on WhatsApp from **ScaleEzy**, with the PDF attached.
4. If the shop's own WhatsApp ever disconnects, the owner is told three ways: a notice in
   **Settings → WhatsApp**, an email, and a WhatsApp from ScaleEzy's number to their Day Book number
   ("your WhatsApp is disconnected, reconnect in Settings").

The ScaleEzy number is shared by every client and every module, so it is kept quiet on purpose:
at most `SCALEEZY_DAILY_CAP` messages a day (150 today), only messages people asked for.

## Journey 2: a client linking their own number

1. The owner (or anyone whose role has **WhatsApp → Manage**) opens **Settings → WhatsApp →
   Link WhatsApp**.
2. On the shop's phone: WhatsApp → **Linked devices** → **Link a device** → scan the QR on the
   screen. (Or choose **Link with phone number instead** and type the 8-letter code shown.)
3. The screen turns green: **Connected**, with the last four digits of the number.
4. That is all, and it is done **once for every module**. When CRM or Billing join, they send
   from the same link. A second link from another module would knock the first one off.

Things the shop should know (the Help Center page says this too):

- The phone keeps working normally. ScaleEzy is just one more "linked device", like WhatsApp Web.
- It stays linked for weeks, whoever signs in to ScaleEzy. It only drops if someone removes it
  from **Linked devices**, WhatsApp is removed or moved to another phone, or **the phone has no
  internet for about 14 days** (WhatsApp's own rule). Then the owner is told and links again.
- A newly linked number sends at most **40 messages a day for its first 14 days**, then
  **200 a day**. Sudden volume from a new link is what gets numbers banned, so the service holds
  the rest until the next day instead of risking the shop's number.
- **Unlink** any time in Settings → WhatsApp (or from the phone's Linked devices list).

## Journey 3: a client's customer or supplier receiving a document

Example: a bill after a counter sale.

1. At the counter, the salesperson presses **Send on WhatsApp** on the bill.
2. Inventory picks the recipient **on its server**, from the sale's customer (never a number
   typed into the browser), builds the bill PDF and hands it to the service.
3. The button shows where it has got to: **Waiting → Sent → Delivered → Read**. If it is
   waiting, it says why (the shop's WhatsApp is not connected, or today's limit is used up).
4. The customer gets the bill **from the shop's own number**, under the shop's name, just as if
   the shop had sent it by hand. They can reply, and the reply arrives on the shop's phone.
5. If the customer replies **STOP**, that shop's number never messages them again (from any
   module). The shop's other customers are not affected, and other shops can still message
   that person.
6. Pressing the button twice, or a slow network retrying, never sends two copies. One press is
   one message.
7. If the shop is not linked yet, the button falls back to **Share on WhatsApp** (the phone's
   normal share menu), so nobody is stuck.

## What is kept, and for how long

| What | Where | How long |
|---|---|---|
| Messages (who, which document, status) | WhatsApp service database | 30 days after finishing (`MESSAGE_RETENTION_DAYS`). The PDF itself is wiped the moment it is sent |
| Message text | Same | Deleted with the message; never written to logs |
| STOP list | Same | Forever. Someone who said STOP must never be messaged again |
| Events to modules, number checks | Same | 7 days |
| Connection history, daily test ("canary") | Same | 90 days |
| Each module's own copy (for its buttons) | The module's database (Inventory: `whatsapp_messages`) | The module's choice |
| Link / unlink, settings changes | Inventory's security log | 180 days |

Phone numbers are shown and logged as the last four digits only (`••••4642`).

## When things go wrong

| What happens | What people see | What the service does |
|---|---|---|
| The shop's phone unlinks or loses WhatsApp | "The shop's WhatsApp is not connected. It goes once it is linked again in Settings > WhatsApp, if that is within a day." Owner told in Settings, by email and by ScaleEzy WhatsApp | Keeps the messages queued; sends them as soon as the shop links again |
| Not linked again within a day | "Not sent within a day, so it was not sent late" | Marks the message **Expired**. A day-old bill arriving out of nowhere confuses customers |
| The number is not on WhatsApp | "This number is not on WhatsApp" | Fails that message only |
| Daily limit reached | "Today's WhatsApp limit for this number is used up, to keep it safe from being blocked. It goes after midnight." | Sends it just after midnight (Indian time) |
| The service or engine restarts | Nothing | Picks up exactly where it stopped; never sends a message twice |
| Engine or network down briefly | A short wait | Retries after 30 s, 2 min, 8 min |
| ScaleEzy's number itself drops | ScaleEzy's daily test fails; admin sees it | Day Books wait until it is relinked (`npm run link:scaleezy`) |

## Where things are

| Piece | Where |
|---|---|
| The service | `whatsapp-service/service`, Render web service `whatsapp-service` |
| The engine (our patched Evolution API image) | `whatsapp-service/engine`, Render private service `whatsapp-engine` |
| Inventory's side | `src/services/whatsapp/` and `src/routes/whatsapp.routes.ts` in the Inventory backend |
| Screens | Inventory frontend: `Settings → WhatsApp`, and the **Send on WhatsApp** buttons |
| Deploying | [README.md → Deploying to Render](../README.md#deploying-to-render) |
| Building a new module on it | [USING-FROM-A-MODULE.md](USING-FROM-A-MODULE.md) |
