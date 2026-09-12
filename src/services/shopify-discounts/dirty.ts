import { prisma } from '../../lib/prisma';

/**
 * An offer changed: its Shopify copies need pushing again.
 *
 * Its own tiny file so the offer service can call it without importing the mirror service, which
 * imports the offer service -- a cycle that would load one of them half-built.
 *
 * A change here is a decision, so it applies even to a copy flagged DRIFTED: a merchant who edits
 * the offer after Shopify's copy was changed has chosen this version. A copy being removed stays
 * being removed. Never throws: a Shopify copy must not be able to stop an offer being saved.
 */
export async function markOfferMirrorsDirty(offerId: string): Promise<void> {
  try {
    await prisma.offerExternalMirror.updateMany({
      where: { offerId, status: { not: 'REMOVING' } },
      data: { status: 'PENDING', attempts: 0, nextAttemptAt: null, problem: null }
    });
  } catch (error) {
    console.error(`[offer mirror] could not queue a push for offer ${offerId}`, error);
  }
}
