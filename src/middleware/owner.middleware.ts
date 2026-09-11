import { Request, Response, NextFunction, RequestHandler } from 'express';
import { holdsEverything } from '../config/permissions';

/**
 * Only the account owner.
 *
 * Deliberately not a permission from the catalogue, and deliberately not a role NAME either
 * -- the note at the foot of permission.middleware explains why role names are never gated
 * on. This asks the same question requirePermission's own bypass asks: does this user hold
 * the wildcard grant, the one issued once when the client is created and belonging to
 * whoever owns the account.
 *
 * It is used for the shop's own identity -- its name and its logo. That is not a task to be
 * delegated the way receiving stock or raising an order is: it is who the business says it
 * is, on every screen its staff look at. A shop that decides otherwise should say so out
 * loud, by asking for a permission to be added here, rather than having one quietly exist.
 *
 * The trade-off is real and worth stating: because this is not in the catalogue, an owner
 * CANNOT hand it to a manager from the roles screen. If that is ever wanted, this becomes a
 * PERMISSIONS entry and the route swaps to requirePermission -- a small change, made on
 * purpose.
 */
export const requireAccountOwner: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).user;

  if (!user || !user.id) {
    return res.status(401).json({ success: false, message: 'Unauthorized: User context missing' });
  }

  if (!holdsEverything(user.permissions, user.roles)) {
    // Says who may do it, because unlike a missing permission there is nothing the person
    // can be granted to fix this -- the answer is always "ask the owner".
    return res.status(403).json({
      success: false,
      message: 'Only the account owner can change the shop’s name and logo.'
    });
  }

  next();
};
