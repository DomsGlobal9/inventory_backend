import { ProductStatus } from '@prisma/client';
import { conflict } from './httpError';

/**
 * Where a product may go from where it is.
 *
 * Sales orders have had a state machine since early on. Products never got one -- every
 * transition was a bare update that did not look at where the product currently was -- and the
 * audit found three separate bugs that all trace back to that single omission:
 *
 *   - Archiving something that was in the BIN took it out of the bin. Status became ARCHIVED
 *     while trashedAt stayed set, so the seven-day wait stopped applying (the hard-delete rule
 *     only recognises TRASHED), and previousStatus was recorded as TRASHED so Restore put it
 *     straight back in the bin with the clock wiped. The product could then never be deleted
 *     at all, and one the shopkeeper had thrown away quietly reappeared in the archive.
 *   - Binning something already binned recorded previousStatus as TRASHED, giving it no way
 *     out, and restarted the seven-day clock on every press.
 *   - Restoring something that had never been archived or binned "restored" it anyway.
 *
 * None of those are clever bugs. They are three faces of one missing check, which is exactly
 * why the check belongs in one place rather than as three ifs inside the service.
 *
 * OUT_OF_STOCK is a live product that happens to have nothing on the shelf, not a stage of its
 * life -- it is reachable and leavable like ACTIVE, and it is never somewhere Restore sends
 * anything, because whether a product is out of stock is decided by the shelf, not by a button.
 */
const transitions: Record<ProductStatus, ProductStatus[]> = {
  DRAFT: ['ACTIVE', 'ARCHIVED', 'TRASHED'],
  ACTIVE: ['DRAFT', 'OUT_OF_STOCK', 'ARCHIVED', 'TRASHED'],
  OUT_OF_STOCK: ['ACTIVE', 'DRAFT', 'ARCHIVED', 'TRASHED'],
  // Out of circulation, and the only ways back are Restore or the bin.
  ARCHIVED: ['DRAFT', 'ACTIVE', 'OUT_OF_STOCK', 'TRASHED'],
  // On its way out. Restore is the ONLY exit -- archiving straight out of the bin is what
  // broke the seven-day wait, so ARCHIVED is deliberately absent here.
  TRASHED: ['DRAFT', 'ACTIVE', 'OUT_OF_STOCK'],
};

const label: Record<ProductStatus, string> = {
  DRAFT: 'a draft',
  ACTIVE: 'on sale',
  OUT_OF_STOCK: 'out of stock',
  ARCHIVED: 'archived',
  TRASHED: 'in the bin',
};

/** Somewhere a product can be sold, counted and added to. */
export const isLive = (status: ProductStatus | string | null | undefined) =>
  status === 'DRAFT' || status === 'ACTIVE' || status === 'OUT_OF_STOCK';

/** What to tell somebody who tried to add to a product that is on its way out. */
export const notLiveReason = (status: ProductStatus | string) =>
  status === 'TRASHED'
    ? 'That product is in the bin. Restore it first.'
    : 'That product is archived. Restore it first.';

export const validateProductTransition = (current: ProductStatus, target: ProductStatus) => {
  if (current === target) {
    throw conflict(`This product is already ${label[current]}.`);
  }
  if (!transitions[current]?.includes(target)) {
    if (current === 'TRASHED' && target === 'ARCHIVED') {
      throw conflict('This product is in the bin. Restore it first if you want to archive it.');
    }
    throw conflict(`A product that is ${label[current]} cannot be made ${label[target]}.`);
  }
};
