# Archived migrations

These 23 migrations are the project's history up to 12 Sep 2026. They are kept for the
record and are **no longer run**.

They were archived because they could not rebuild the application. Between them they create
27 tables; the schema has 61. The other 34 arrived through `db push` and through the DDL
used during the Sydney -> Singapore database move, which built the target schema from the
live database precisely because the migrations could not. A database created from this
folder would be missing more than half of its tables -- which meant disaster recovery, a new
environment and a new developer's machine were all quietly broken.

`prisma/migrations/0_baseline` replaces them. It is generated from the live production
schema and creates all 61 tables, 35 enums, 148 indexes and 51 foreign keys.

Do not run these. Read them if you want to know how something came to be.
