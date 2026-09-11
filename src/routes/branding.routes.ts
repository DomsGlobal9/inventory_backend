import { Router, Request, Response, NextFunction } from 'express';
import { tenantMiddleware } from '../middleware/tenant.middleware';
import { requireAccountOwner } from '../middleware/owner.middleware';
import { brandingService } from '../services/branding.service';

const router = Router();

router.use(tenantMiddleware);

const clientOf = (req: Request) => (req as any).clientId as string;

const handle = (fn: (req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await fn(req) });
    } catch (error: any) {
      if (error?.statusCode) {
        return res.status(error.statusCode).json({ success: false, message: error.message });
      }
      next(error);
    }
  };

/**
 * Reading is for everybody signed in; changing is the owner's alone.
 *
 * The split matters: the shop's name and logo appear on screens every member of staff uses,
 * so gating the READ on the owner would leave the app looking unbranded for everyone except
 * one person. What is restricted is deciding what they are.
 */
router.get('/', handle(req => brandingService.get(clientOf(req))));

router.put('/name', requireAccountOwner, handle(req =>
  brandingService.setName(clientOf(req), req.body?.businessName ?? null)
));

// Same three-step upload as product images -- server derives the path, browser PUTs to a
// single-use signed URL, then echoes the path back to be recorded. See image.service for
// why the browser is never trusted with a clientId or a Supabase key.
router.post('/logo/upload-url', requireAccountOwner, handle(req =>
  brandingService.createLogoUploadUrl(clientOf(req), req.body?.fileName)
));

router.put('/logo', requireAccountOwner, handle(req =>
  brandingService.setLogo(clientOf(req), req.body?.storagePath)
));

router.delete('/logo', requireAccountOwner, handle(req =>
  brandingService.removeLogo(clientOf(req))
));

export default router;
