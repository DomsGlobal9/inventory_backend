import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { prisma } from '../lib/prisma';

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

  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

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
