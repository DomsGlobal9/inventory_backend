import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const requestId = crypto.randomUUID();
  
  // Attach request ID for downstream logging and to the response
  (req as any).requestId = requestId;
  res.setHeader('x-request-id', requestId);

  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] [ReqID: ${requestId}] ${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
  });

  next();
};
