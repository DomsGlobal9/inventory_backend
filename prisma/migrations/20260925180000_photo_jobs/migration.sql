-- Making a set of photographs, on this side rather than in a browser tab.
--
-- Until now the whole generation lived in the page: the browser opened the stream to the photo
-- studio AND saved each view as it arrived. Whoever pressed the button had to sit and watch it
-- for the better part of a minute. Closing the tab, walking to the counter, or simply opening
-- another screen recorded the generation as cancelled -- after the GPU time had already been
-- spent. Nothing on this side knew a job existed, so nothing could finish it and nothing could
-- say that it had.
--
-- One row here IS the job. A worker claims it, runs it, and writes down what happened.
--
-- Additive only: a new table, no column added to an existing one, and no value added to any
-- enum. A deployment still running the previous code neither sees this nor needs it -- which is
-- the property that was missing on 23 September, when a new InventoryAlertType value took the
-- alerts endpoint down. Both `kind` and `status` are TEXT for the same reason: a sixth status
-- next year must not be able to repeat that.
CREATE TABLE IF NOT EXISTS "photo_jobs" (
  "id"         TEXT NOT NULL,
  "client_id"  TEXT NOT NULL,
  "product_id" TEXT NOT NULL,

  -- 'VIEWS' (the four catalog views from one photograph) or 'COLOUR' (this colour, copied from
  -- another colour's generated front view).
  "kind"   TEXT NOT NULL,
  -- 'QUEUED' -> 'RUNNING' -> 'DONE' | 'FAILED' | 'CANCELLED'.
  "status" TEXT NOT NULL DEFAULT 'QUEUED',

  -- A job targets a COLOUR, never a single variant: red/S, red/M and red/L are one colour with
  -- one set of photographs, and asking per variant would generate the same pictures three times
  -- over and bill for all three.
  "colour_name" TEXT NOT NULL,
  "colour_key"  TEXT NOT NULL,
  "colour_hex"  TEXT,
  "variant_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  -- The row it is made from, and the address as it stood when the job was made. Both, because
  -- the far end fetches the address itself and the row may be deleted while the job still runs.
  "source_image_id"  TEXT,
  "source_image_url" TEXT NOT NULL,

  -- What the far end calls this job, and therefore what cancelling it has to name. The suffix
  -- only -- the tenant is put in front by jobKeyFor so one shop cannot name a job in another.
  "job_key" TEXT NOT NULL,

  -- Fixed for the life of the job, so a retry after a restart asks for the same model as the
  -- views already saved. Four views of one garment on two different models is not a set.
  "category" TEXT NOT NULL,
  "model_id" TEXT NOT NULL,

  "views_done"  INTEGER NOT NULL DEFAULT 0,
  "views_total" INTEGER NOT NULL DEFAULT 4,

  -- Shown to the shop exactly as written, so it is written in words they can act on.
  "message"      TEXT,
  "requested_by" TEXT,

  -- The runner may be on another instance; this is how a stop request reaches it. The far end
  -- is told separately and directly, which is what actually ends the stream.
  "cancel_requested" BOOLEAN NOT NULL DEFAULT false,

  -- A redeploy strands whatever was running. One automatic retry is the difference between the
  -- shop getting their photographs and being told to press the button again; two would be
  -- spending their allowance on a guess.
  "attempts" INTEGER NOT NULL DEFAULT 0,

  -- Touched while the stream is alive. A RUNNING row that has stopped being touched belongs to
  -- an instance that has gone.
  "heartbeat_at" TIMESTAMP(3),
  "started_at"   TIMESTAMP(3),
  "finished_at"  TIMESTAMP(3),

  -- Null until somebody has been told. This is what makes "I was signed out when it finished"
  -- work: the notice waits for them instead of being missed.
  "seen_at" TIMESTAMP(3),

  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "photo_jobs_pkey" PRIMARY KEY ("id")
);

-- CASCADE, deliberately. A job is about a product; delete the product and there is nothing left
-- for the job to be about. This is also what answers "the client was deleted while a job ran" --
-- the client sweep deletes the products, and these go with them. (It would be caught anyway:
-- the sweep in platform-admin.service.ts deletes from every table carrying a client_id and then
-- asks the database whether any row survived, so this table is covered the moment it exists.)
DO $$ BEGIN
  ALTER TABLE "photo_jobs"
    ADD CONSTRAINT "photo_jobs_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "inventory_products"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "photo_jobs_client_id_status_idx"  ON "photo_jobs"("client_id", "status");
CREATE INDEX IF NOT EXISTS "photo_jobs_product_id_idx"        ON "photo_jobs"("product_id");
-- How the worker finds its next piece of work: oldest queued first.
CREATE INDEX IF NOT EXISTS "photo_jobs_status_created_at_idx" ON "photo_jobs"("status", "created_at");

-- Two people cannot make the same colour at the same time.
--
-- Enforced here rather than by looking first and then inserting, because that check and that
-- insert are two statements with a gap between them, and the owner and the manager pressing the
-- button together land in exactly that gap. The second insert is refused by the database, and
-- the endpoint turns the refusal into "that one is already being made".
--
-- Partial, so only QUEUED and RUNNING rows take part: a colour that was made last week, or that
-- failed and needs running again, must not be blocked by its own history. Prisma cannot express
-- a partial index, so it exists only here -- it is deliberate, not drift.
CREATE UNIQUE INDEX IF NOT EXISTS "photo_jobs_one_active_per_colour"
  ON "photo_jobs"("product_id", "colour_key")
  WHERE "status" IN ('QUEUED', 'RUNNING');
