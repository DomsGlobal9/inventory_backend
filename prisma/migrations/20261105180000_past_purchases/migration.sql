-- 5 Nov 2026. A shop's customers and bills from BEFORE it came to ScaleEzy, loaded from its own records.
--
-- Past bills are NOT sales orders on purpose: they took no stock, they are not in the Day Book, GST or
-- reports, and most have no date. They hang off the real customer row, so a new bill at the till or online
-- finds the same person by number and nothing is ever duplicated. Tables and one nullable column only:
-- no enum, so a deployed build reading the shared database is not affected.

-- The load that made this customer. Null for everybody else. "New customers today" leaves these out.
ALTER TABLE "customers" ADD COLUMN "import_source" TEXT;

CREATE TABLE "past_purchases" (
    "id"          TEXT NOT NULL,
    "client_id"   TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "source"      TEXT NOT NULL,
    "bill_no"     TEXT NOT NULL,
    -- Null means the date is not known. It is never guessed, so nothing date-based may use such a bill.
    "billed_on"   DATE,
    "net"         DECIMAL(12,2) NOT NULL,
    "paid_by"     TEXT,
    -- [{ kind, fabric, quantity, amount }]. A return is a negative line.
    "lines"       JSONB NOT NULL DEFAULT '[]',
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "past_purchases_pkey" PRIMARY KEY ("id")
);
-- One bill number once per load: running a load twice adds nothing.
CREATE UNIQUE INDEX "past_purchases_client_id_source_bill_no_key" ON "past_purchases"("client_id", "source", "bill_no");
CREATE INDEX "past_purchases_client_id_customer_id_idx" ON "past_purchases"("client_id", "customer_id");
ALTER TABLE "past_purchases" ADD CONSTRAINT "past_purchases_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One row per load. Once finished, running it again changes nothing, so a customer the owner deleted
-- afterwards does not come back.
CREATE TABLE "past_purchase_imports" (
    "client_id"         TEXT NOT NULL,
    "source"            TEXT NOT NULL,
    "file_hash"         TEXT NOT NULL,
    "customers_created" INTEGER NOT NULL DEFAULT 0,
    "customers_matched" INTEGER NOT NULL DEFAULT 0,
    "bills_added"       INTEGER NOT NULL DEFAULT 0,
    "started_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at"       TIMESTAMP(3),
    CONSTRAINT "past_purchase_imports_pkey" PRIMARY KEY ("client_id", "source")
);

-- CRM hears of them like any other change: past_purchase.created / .deleted. A delete of the customer
-- cascades here, and the row trigger fires for it too.
CREATE TRIGGER module_outbox_ins AFTER INSERT ON "past_purchases" FOR EACH ROW EXECUTE FUNCTION module_outbox_capture('past_purchase');
CREATE TRIGGER module_outbox_upd AFTER UPDATE ON "past_purchases" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION module_outbox_capture('past_purchase');
CREATE TRIGGER module_outbox_del AFTER DELETE ON "past_purchases" FOR EACH ROW EXECUTE FUNCTION module_outbox_capture('past_purchase');
