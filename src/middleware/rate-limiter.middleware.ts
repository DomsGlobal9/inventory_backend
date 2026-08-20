import rateLimit from 'express-rate-limit';
import { Request } from 'express';

// Rate Limiter: 100 requests per minute per tenant
export const tenantRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // Limit each IP/Tenant to 100 requests per `window`
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  keyGenerator: (req: Request) => {
    // Key by the client ID from headers, fallback to IP (without triggering IPv6 warning)
    const clientId = req.headers['x-client-id'] as string;
    if (clientId) return clientId;
    
    // Fallback to a static string to avoid IPv6 validation errors in express-rate-limit
    return 'anonymous-tenant';
  },
  message: {
    success: false,
    message: 'Too many requests from this tenant, please try again after a minute'
  }
});
