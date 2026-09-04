import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

/**
 * Turns a Prisma engine error into something a shop owner can act on.
 *
 * Prisma's own message is a developer artefact -- creating a location with a code that is
 * already taken put this in front of the user, verbatim, in a toast:
 *
 *   Invalid `prisma.stockLocation.create()` invocation:
 *   Unique constraint failed on the fields: (`client_id`,`code`)
 *
 * which names internal columns, exposes the ORM and the table, and never says what to do.
 * These are ordinary user mistakes, so they also stop being 500s -- which matters twice
 * over, because 5xx responses are persisted to the Platform Console's Errors page and a
 * duplicate code is not a crash.
 */
function translatePrismaError(err: any): { statusCode: number; message: string } | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return null;

  // `target` is the failing column list, e.g. ['client_id', 'code']. clientId is on almost
  // every unique constraint as the tenant scope and means nothing to the user, so name the
  // remaining field(s) instead.
  const fieldsOf = (meta: any): string[] => {
    const target = meta?.target;
    const raw = Array.isArray(target) ? target : typeof target === 'string' ? [target] : [];
    return raw.filter(f => f !== 'client_id' && f !== 'clientId');
  };

  switch (err.code) {
    case 'P2002': {
      const fields = fieldsOf(err.meta);
      const label = fields.length ? fields.join(' and ') : 'value';
      return { statusCode: 409, message: `That ${label} is already in use. Choose a different one.` };
    }
    case 'P2025':
      return { statusCode: 404, message: 'That record no longer exists. It may have been deleted.' };
    case 'P2003':
      return {
        statusCode: 409,
        message: 'This is still referenced by other records, so it cannot be changed or removed.'
      };
    default:
      return null;
  }
}

export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  console.error(`[Error] ${req.method} ${req.path}`, err);

  if (err instanceof ZodError) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: err.errors
    });
  }

  const translated = translatePrismaError(err);
  const statusCode = translated?.statusCode ?? err.statusCode ?? 500;
  const message = translated?.message ?? err.message ?? 'Internal Server Error';

  // 5xx only -- a validation 400 or a permission 403 is expected traffic, not something
  // the Platform Console needs paged for. Fire-and-forget: persisting the error must never
  // be the reason the actual error response is slow or fails.
  if (statusCode >= 500) {
    const user = (req as any).user;
    prisma.clientErrorLog.create({
      data: {
        clientId: user?.clientId || null,
        userId: user?.id || null,
        userEmail: user?.email || null,
        source: 'BACKEND',
        message: String(message).slice(0, 2000),
        stack: err.stack ? String(err.stack).slice(0, 8000) : null,
        route: `${req.method} ${req.path}`,
        statusCode
      }
    }).catch(logErr => console.error('Failed to persist backend error log', logErr));
  }

  res.status(statusCode).json({
    success: false,
    message,
  });
};
