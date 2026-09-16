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
  // 100 per address per minute unless RATE_LIMIT_MAX says otherwise. Settable so a test server can run
  // suites that make more than 100 calls a minute, and so production can be raised without a code
  // change if several tills behind one shop's router share an address.
  max: Number(process.env.RATE_LIMIT_MAX) > 0 ? Number(process.env.RATE_LIMIT_MAX) : 100,
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: {
    success: false,
    message: 'Too many requests from this address, please try again after a minute'
  }
});
