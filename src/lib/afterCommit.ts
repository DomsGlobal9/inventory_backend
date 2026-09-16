import { AsyncLocalStorage } from 'async_hooks';

/**
 * Work that must wait until the database transaction it belongs to has committed.
 *
 * Stock changes tell connected storefronts about themselves. That message used to go out with
 * setImmediate, "after the transaction" -- which is only true when the stock change IS the whole
 * transaction. Inside a larger one (a dispatch of several lines, a counter sale) the next tick
 * comes long before the commit, so the storefront read the stock as it was BEFORE the sale, or
 * heard about a change the transaction then rolled back. Either way the website is told something
 * false, and a stale "in stock" is how an oversell happens.
 *
 * So every interactive transaction carries a queue. afterCommit() adds to the queue of the
 * transaction it is running inside; the queue runs once that transaction has committed, and is
 * simply dropped if it throws. Outside any transaction there is nothing to wait for, and the work
 * runs on the next tick as before.
 *
 * AsyncLocalStorage rather than threading a list through every function: the stock code is called
 * from a dozen places, with and without a caller's transaction, and "which transaction am I in" is
 * exactly what async context is for.
 */
const pending = new AsyncLocalStorage<Array<() => void>>();

export function afterCommit(work: () => void): void {
  const queue = pending.getStore();
  if (queue) queue.push(work);
  else setImmediate(work);
}

/** Wraps a Prisma client's interactive $transaction so afterCommit() knows when to run. */
export function holdAfterCommitWork<T extends { $transaction: any }>(client: T): T {
  const original = client.$transaction.bind(client);
  const wrapped = (arg: any, options?: any) => {
    // The array form runs no code of ours in between, so it can queue nothing.
    if (typeof arg !== 'function') return original(arg, options);
    const queue: Array<() => void> = [];
    return pending.run(queue, async () => {
      const result = await original(arg, options);
      // Committed. Run each outside this transaction's context, so work that itself calls
      // afterCommit is not added to a queue that has already been emptied.
      for (const work of queue.splice(0)) pending.exit(() => setImmediate(work));
      return result;
    });
  };
  Object.defineProperty(client, '$transaction', { value: wrapped, configurable: true, writable: true });
  return client;
}
