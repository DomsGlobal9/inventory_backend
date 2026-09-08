# Moving the database to Singapore

Status: planned, not started.

## Why

Measured, not guessed:

| | Oregon backend | Singapore backend |
|---|---|---|
| Base HTTP, no database | 0.30 s | **0.10 s** |
| One database query | 1.24 s | 1.55 s |
| Server-side (the database hop) | 0.94 s | ~1.45 s |

Moving the backend to Singapore made requests reach the app three times faster and made the
database hop slightly *worse*. That is the clearest possible evidence for this migration: the
app was never the distant end. The database is, and it stays distant wherever the app moves.

A database in the same region answers in **5–15 ms**. Today it answers in roughly a second.
Every page in the product is built out of several of those.

## What moves

| | From | To |
|---|---|---|
| Supabase project | `ap-southeast-2` (Sydney) | `ap-southeast-1` (Singapore) |
| Backend | already moved | Render Singapore — keep |
| Frontend | Vercel (CDN) | unchanged |

Supabase cannot change a project's region in place. This is a new project plus a data move.

## The trap that would break every product photo

39 of the 40 rows in `inventory_product_images` store a **fully-qualified URL** containing the
current project's hostname:

```
https://psexbaagmgeoyvtbdbbm.supabase.co/storage/v1/object/public/inventory-images/...
```

A new project has a different hostname. Copying the files across is not enough — every one of
those stored URLs would keep pointing at the old project, and once the old project is deleted
every product photo in the app and on every connected storefront goes blank.

The rewrite is step 5 and is not optional.

Check `storagePath` too: the sample row has it null, and the client-deletion cleanup relies on
it to remove files from storage. Rows without it leave orphaned files behind. Worth fixing
separately, but note it before the move so it is not mistaken for migration damage.

## Steps

### 1. Prepare (no downtime)
- Create a Supabase project in **`ap-southeast-1`**.
- Create the `inventory-images` bucket with the same public setting as the current one.
- Note the new `DATABASE_URL` (pooler, port **6543**, `?pgbouncer=true`), `DIRECT_URL`
  (port 5432), `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

### 2. Rehearse
Do the whole of steps 3–6 against the new project **before** the real window, with the old one
still live. Nothing here is destructive to the old project, so a rehearsal costs only time and
removes every surprise from the real run.

### 3. Stop writes
Pick a quiet hour. Either suspend every client from the platform console, or scale the Render
service to zero. The point is that no write lands in the old database after the dump is taken —
a write that arrives afterwards is silently lost.

### 4. Move the data
```bash
# From the OLD project's DIRECT_URL (5432, not the pooler)
pg_dump --no-owner --no-acl --format=custom \
  --dbname="$OLD_DIRECT_URL" --file=scaleezy.dump

pg_restore --no-owner --no-acl --dbname="$NEW_DIRECT_URL" scaleezy.dump
```
The `_prisma_migrations` table comes with the dump, so the new database already knows which
migrations have run and `prisma migrate deploy` on the next boot is a no-op.

### 5. Move the images, then rewrite the URLs
Copy the bucket contents (Supabase CLI, `rclone`, or a short script over the storage API), then
point the stored URLs at the new project:

```sql
UPDATE inventory_product_images
SET url = REPLACE(url, 'psexbaagmgeoyvtbdbbm.supabase.co', '<new-project-ref>.supabase.co')
WHERE url LIKE '%psexbaagmgeoyvtbdbbm.supabase.co%';
```

Then confirm none remain:

```sql
SELECT COUNT(*) FROM inventory_product_images
WHERE url LIKE '%psexbaagmgeoyvtbdbbm.supabase.co%';   -- must be 0
```

### 6. Repoint the application
On the Singapore Render service, replace: `DATABASE_URL`, `DIRECT_URL`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`. Everything else is unchanged. Redeploy.

### 7. Verify before letting anyone back in
```bash
npx ts-node src/scripts/verify-reports.ts
npx ts-node src/scripts/verify-daybook.ts
npx ts-node src/scripts/verify-storefront.ts
npx ts-node src/scripts/verify-new-client-e2e.ts
npx ts-node src/scripts/verify-dashboard-all-tenants.ts
```
Then by hand: sign in, open a product **and look at its photograph**, take a stock movement,
open the Day Book.

And measure, which is the whole point:
```bash
curl -s -o /dev/null -w "%{time_total}s\n" -X POST \
  -H "Content-Type: application/json" \
  -d '{"email":"nobody@example.invalid","password":"x"}' \
  https://<backend>/api/v1/auth/login
```
Expect roughly **0.15 s**, against 1.55 s today. If it is not, stop and find out why before
reinstating clients.

### 8. Let clients back in
Reinstate from the console, or scale the service back up.

## Rollback

Trivial until the old project is deleted: put the old four environment variables back and
redeploy. That is the entire rollback, and it is why the old project must be **kept running,
untouched, for at least a week** — long enough to be sure no rarely-used screen depends on
something the dump missed.

Anything written to the new database during that week is lost on rollback, which is the real
reason to verify thoroughly at step 7 rather than reinstating clients and hoping.

## Honest assessment

Steps 3–8 are an evening. The risky parts are exactly two: writes arriving after the dump
(handled by stopping writes first), and the image URLs (handled by step 5, and the reason to
open a product page by eye at step 7 rather than trusting a green test suite).

The payoff is the largest single improvement available to this product: every query in the
application goes from about a second to about ten milliseconds.
