import rateLimit from 'express-rate-limit';

// Rate Limiter: 100 requests per minute per caller.
//
// This runs before `authenticate` (mounted at the /api level in server.ts, ahead of
// api.routes.ts's global auth check), so there is no verified req.user.clientId to key
// on yet at this point in the pipeline. Keying on the client-supplied `x-client-id`
// header instead was worse than not rate-limiting at all: any caller could rotate a
// fake header to dodge the limit, or spoof a real tenant's header to exhaust their
// bucket and DoS them. Falling back to express-rate-limit's default IP-based keying
// closes both of those — it can't be forged the same way.
export const tenantRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // Limit each IP to 100 requests per `window`
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: {
    success: false,
    message: 'Too many requests from this address, please try again after a minute'
  }
});
