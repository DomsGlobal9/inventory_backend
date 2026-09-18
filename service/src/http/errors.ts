import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import type { Logger } from 'pino';
import { AppError, Errors } from '../lib/errors';
import { EngineError } from '../engine/client';
import { describeZodError } from './schemas';

/** Wraps an async route so every failure reaches the error handler (no unhandled rejections). */
export function route(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) return Errors.badRequest(describeZodError(err));
  if (err instanceof EngineError) {
    if (err.kind === 'not_on_whatsapp') return Errors.badRequest('This number is not on WhatsApp.');
    if (err.kind === 'not_connected') return Errors.disconnected();
    if (err.kind === 'rejected') return new AppError(502, 'engine_refused', 'WhatsApp refused this request. Please try again.');
    return Errors.engineUnavailable();
  }
  if (err instanceof Prisma.PrismaClientInitializationError || isPrismaConnectionError(err)) {
    return new AppError(503, 'unavailable', 'The WhatsApp service is briefly unavailable. Please try again in a minute.');
  }
  const e = err as { type?: string; status?: number };
  if (e?.type === 'entity.parse.failed') return Errors.badRequest('The request body is not valid JSON.');
  if (e?.type === 'entity.too.large') return Errors.tooLarge('This request is too large. PDFs must be 5 MB or smaller.');
  if (e?.type === 'encoding.unsupported' || e?.type === 'charset.unsupported') return Errors.badRequest('The request encoding is not supported.');
  return Errors.internal();
}

function isPrismaConnectionError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].includes(err.code);
  if (err instanceof Prisma.PrismaClientUnknownRequestError || err instanceof Prisma.PrismaClientRustPanicError) return true;
  return false;
}

export function errorHandler(log: Logger) {
  // Express recognises an error handler by its four parameters.
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const appErr = toAppError(err);
    if (appErr.status >= 500) log.error({ err, path: req.route?.path ?? 'unknown', method: req.method }, 'request failed');
    if (res.headersSent) return;
    res.status(appErr.status).json({ error: { code: appErr.code, message: appErr.message, ...(appErr.extra ?? {}) } });
  };
}
