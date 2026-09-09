# How this market works, and where Scaleezy actually stands

Written after a long pass through the code, the database and the live product. Where something
is inference rather than something I verified, it says so. Competitor pricing is from general
knowledge and may be stale — check it before quoting it to anyone.

---

## 1. What the numbers in your own database say

This is the part I am confident about, because I read it.

- **42 tenants**, and most hold very little. `sphl` has 3 variants and 92 units. Several have
  none.
- **669 units across five shops were held with no cost recorded at all** until this week.
- **No billing anywhere in the product.** No plan, no price, no card, no invoice. The only
  metering that exists is try-on usage.
- **Signing up records a lead.** Onboarding is a platform admin doing it by hand.
- **One database round trip costs about a second**, because the app is in Oregon and the
  database is in Sydney, and the customers are in India.

Read together: this is **pre-revenue, with a large feature surface and a small amount of real
data in it**. That is the single most important fact for deciding what to do next, and it is
not a criticism — it is just where the product is.

---

## 2. How this market actually works

### The accountant is the distribution channel

Indian small retail does not buy software from advertisements. It buys what its CA tells it to
buy, because the CA has to work with the output. Tally did not win on product; it won because
every accountant already knew it.

**This is why keeping accounting language in the reports is a commercial decision, not a UX
one.** A report a CA can read without translation is a report that gets Scaleezy recommended.
A report that says "You Keep" is a report the CA asks the shop to stop sending.

### Compliance is what gets bought; inventory is what gets used

Most Indian SMB software is bought to produce a GST invoice. Inventory is a by-product of a
compliance purchase. Vyapar, Marg, Busy and Tally all lead with billing and GST.

**I had this wrong, and the correction changes the conclusion.** I looked only inside this
repository, found no tax invoice, and called it a missing reason to buy. GST and sales are
**separate Scaleezy modules**. This one is Inventory, and it does not do them because it is not
supposed to.

That is a materially stronger position than I gave it credit for. The compliance wedge and the
shop-floor tool come from the same vendor, which is something none of the incumbents offer —
Tally is the accountant's, Vyapar is the shopkeeper's, and neither is both.

**But it introduces the question that decides whether the suite is real:**

> When a sale is invoiced in the GST module, does the stock go down in this one?

If it does, Scaleezy sells one truth to a shop that currently keeps two. If it does not, the
shop maintains its stock twice — which is the exact problem this product exists to remove, now
reproduced inside the product. I have not looked at the other modules and cannot say which it
is. It is the first thing I would check, ahead of anything in the feature backlog.

The same question applies in the other direction: a purchase received here should be available
to the accounts module as a purchase, not retyped.

### The price anchor is very low

Vyapar sits in the low hundreds of rupees a month. Zoho is in the same territory for a small
shop. Tally is a one-time licence people keep for a decade.

A shop comparing Scaleezy to those will not pay a multiple of them for better inventory alone.
It will pay a multiple for something the others cannot do at all.

### Vertical beats horizontal at this size

General inventory is a solved, crowded, commoditised category with incumbents who have decades
of distribution. Competing there is not winnable.

Clothing retail with real variants — colour, size, fabric, a hundred SKUs behind one product —
is a genuinely different shape of problem, and the generalists handle it badly.

---

## 3. What Scaleezy actually has that others do not

### Try-on

Nothing in the Indian SMB inventory market does this. It is demonstrable in thirty seconds in
a shop, on the shopkeeper's own phone, using a garment they are holding. That is a rare thing
to own.

It is also **already metered per use**, which means the pricing model is half built.

### Honesty about numbers

I want to name this because it is unusual and I only noticed it from the inside.

This product tells you when a figure is a guess. The dashboard says *"46 units are valued at
their selling price because no cost was recorded"*. The margin column says which cost it used.
The purchase order says *"only ₹150 a piece at this cost"* before you send it. The valuation
and the console agree, and where they cannot, the screen now says why.

**Every competitor shows a confident number.** None of them tell you the number is soft.

For a shopkeeper who has been burned by a stock figure that did not match the shelf, *"the
system that tells you when it does not know"* is a real position, and it is one nobody else in
this category is claiming. It also happens to be true, which is the hard part.

### Multi-shop, done properly

Per-location stock, prices and reorder levels, with transfers that conserve the total, and a
company-wide figure alongside the shop-level one. Most tools at this price treat multi-location
as an afterthought.

---

## 4. What blocks selling, in order

| | Why it blocks | State |
|---|---|---|
| **Modules sharing one set of numbers** | If they do not, the shop keeps stock twice | **Unknown — check first** |
| **The second-per-query latency** | See below | **Being moved** |
| **No billing** | Cannot take money without a person raising an invoice | Open |
| **No offline tolerance** | Indian retail connectivity is not the assumption this app makes | Open |

GST is not on this list any more. It is another module's job.

### The latency is a market problem, not an engineering one

I measured it: `/health` 0.30s, `/ready` 1.30s. One second per database round trip. The product
detail page took **10.7 seconds** from a laptop.

A shopkeeper in Chirala on 4G, waiting five seconds for a product to open, stops using the
product. They will not file a bug — they will go back to the notebook, and the churn will be
recorded as "did not adopt".

**This is being moved.** Once Supabase and Render sit in the same region as each other and
near the customers, most of what feels slow in this product stops being slow — including the
console screens, which are already down to a single round trip each and cannot get faster any
other way.

---

## 5. What I would do

### Lead with try-on, retain with inventory

Try-on is the thing that gets a shopkeeper to look up. Inventory is the thing that means they
are still there in six months. That ordering matters for the sales conversation and for what
goes at the top of the landing page.

The current landing page leads with stock control, which is the *correct* product but the
*harder* sale — it competes head-on with what a shop already believes it has solved with a
notebook.

### Price where value already is

The try-on metering exists. A small monthly for inventory plus a per-try-on charge fits the
code that is already written, keeps the entry price below the anchor, and means the shop pays
more only when it is selling more. That is an easier conversation than a per-seat tier.

I would not publish a price until billing exists — which is also why the `price: 0` I put in
the structured data had to come out.

### Narrow before widening

Storefront sync, Shopify, try-on, transfers, returns, sales orders, dispatch, stock counts, a
platform console, support tickets and an error engine — with 42 tenants, most holding almost
nothing.

Every feature is a maintenance liability. This week alone, testing turned up an invisible Save
button, a margin column switched off for 82% of the catalogue, a purchase order warning that
never fired, and sixteen console actions that left no audit trail. Those are not sloppiness —
they are the arithmetic of a surface larger than the attention available for it.

**I would ship nothing new until the region move lands and the module seam is verified.** Not
because the other ideas are bad, but because a shop that has to enter its stock twice will stop
entering it once, and no feature recovers from that.

### Distribution: three routes, in order of leverage

1. **Accountants.** Whoever does a saree shop's books talks to twenty more. This is why the
   reports have to speak their language.
2. **Wholesalers and distributors.** One saree wholesaler supplies dozens of retailers and has
   a reason to want them organised.
3. **One lighthouse shop per town.** Retail is intensely local and shopkeepers copy the shop
   down the road. One visible reference beats ten cold calls.

Direct outbound to individual shops is the slowest of the three and the one most likely to be
attempted first.

---

## 6. The honest summary

**What is genuinely good:** the try-on, the multi-shop model, and a rigour about numbers that
is rare in this category and that the product can defend because it is real.

**What is genuinely missing:** billing, and proof that the modules share one set of numbers.
The region move is in hand and GST belongs to another module.

**The strategic risk:** breadth. A feature surface already wider than 42 thin tenants justify,
and a suite whose modules must agree about stock or the whole argument for buying it collapses.

**The position I would take to market:**

> Inventory for clothing shops that tells you the truth about your stock — including when it
> does not know. Plus a try-on your customers can use from the tag on the garment.

The second sentence gets the meeting. The first one keeps the customer.
