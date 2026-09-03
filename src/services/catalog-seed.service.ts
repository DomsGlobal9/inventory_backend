import { prisma } from '../lib/prisma';

// Runs `items` through `fn` with at most `limit` in flight at once -- same pattern as
// rbac-seed.service.ts, and for the same reason: this environment's Prisma connection
// pool tops out well below what a bare `Promise.all` over ~70 rows would demand.
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Copies a CatalogTemplate's items into a client's own ClientCatalogItem rows, marked
// `isSystem: true` -- these tables and this exact relationship (see the doc comment on
// ClientCatalogItem.isSystem: "copied from template") already existed in the schema,
// just never wired up anywhere. Idempotent: upserting on the same
// [clientId, type, value, category] unique constraint the client-editing routes already
// enforce, so re-running this (e.g. a future "Restore Defaults" action) never duplicates
// rows and never touches items a client added or edited themselves.
export async function seedCatalogDefaultsForClient(clientId: string, templateName = 'Default') {
  const template = await prisma.catalogTemplate.findUnique({
    where: { name: templateName },
    include: { items: true }
  });

  if (!template) {
    throw new Error(`Catalog template "${templateName}" not found`);
  }

  const existingItems = await prisma.clientCatalogItem.findMany({
    where: { clientId },
    select: { type: true, value: true, category: true }
  });
  
  const existingSet = new Set(
    existingItems.map(i => `${i.type}|${i.value}|${i.category ?? ''}`)
  );

  const dataToInsert = template.items
    .filter(item => !existingSet.has(`${item.type}|${item.value}|${item.category ?? ''}`))
    .map(item => ({
      clientId,
      type: item.type,
      value: item.value,
      label: item.label,
      category: item.category ?? undefined,
      metadata: item.metadata ?? undefined,
      sortOrder: item.sortOrder,
      isSystem: true
    }));

  if (dataToInsert.length > 0) {
    await prisma.clientCatalogItem.createMany({ data: dataToInsert });
  }

  return { templateName, itemCount: template.items.length };
}
