import { Request, Response, NextFunction, RequestHandler } from 'express';
import { grants, getPermission, holdsEverything } from '../config/permissions';

export const requirePermission = (requiredPermission: string): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      
      if (!user || !user.id) {
        return res.status(401).json({ success: false, message: 'Unauthorized: User context missing' });
      }

      // The account owner passes everything.
      //
      // This used to be `user.roles.includes('SUPER_ADMIN')` written out here, and that was the
      // whole of authorisation for most of the platform's users -- their stored permissions were
      // never read at all. It is now the '*' grant, asked through one helper that also honours
      // the old role name until every database has issued that grant. When that is done, the
      // second half of holdsEverything goes and this line keeps working unchanged.
      if (holdsEverything(user.permissions, user.roles)) {
        return next();
      }

      // Asked of the catalogue, not of the raw list, so implication happens in one place.
      //
      // A role stores what was ticked. `report:financial` confers `report:view` and
      // `cost:view` without either being stored against it, and adding an implication later
      // applies to every existing role immediately -- which storing the expansion would not.
      if (!grants(user.permissions || [], requiredPermission)) {
        // Say what the person cannot do, not which key they are missing. "Missing required
        // permission [purchase_order:receive]" tells a shopkeeper nothing and tells whoever
        // has to fix it only slightly more.
        const def = getPermission(requiredPermission);
        return res.status(403).json({
          success: false,
          message: def
            ? `You do not have permission to: ${def.label.toLowerCase()}. Ask whoever manages your team.`
            : `Forbidden: Missing required permission [${requiredPermission}]`,
          requiredPermission
        });
      }

      next();
    } catch (error) {
      return res.status(500).json({ success: false, message: 'Internal server error checking permissions' });
    }
  };
};

// There is no requireRole. Gating a route on a role NAME is how this middleware came to have
// a SUPER_ADMIN bypass that meant most users' stored permissions were never read at all. Routes
// are gated on permissions, which are grants: visible in the database, auditable, revocable.
// A shop that renames a role, or composes a new one, keeps working.
