import type { NextFunction, Request, Response } from 'express';
import type { ModuleClient } from '@prisma/client';
import type { Ctx } from '../context';
import { hashModuleKey, safeEqual } from '../lib/crypto';
import { Errors } from '../lib/errors';

declare module 'express-serve-static-core' {
  interface Request {
    module?: ModuleClient;
  }
}

/** `x-module-key`: looked up by its sha256, then compared in constant time. */
export function requireModule(ctx: Ctx) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const key = req.get('x-module-key');
      if (!key || key.length > 200) throw Errors.unauthorized();
      const hash = hashModuleKey(key);
      const mod = await ctx.db.moduleClient.findUnique({ where: { keyHash: hash } });
      if (!mod || !safeEqual(mod.keyHash, hash) || !mod.active) throw Errors.unauthorized();
      req.module = mod;
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** `x-admin-key` for the platform console. */
export function requireAdmin(ctx: Ctx) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const key = req.get('x-admin-key');
    if (!key || !safeEqual(key, ctx.config.ADMIN_KEY)) return next(Errors.unauthorized());
    next();
  };
}
