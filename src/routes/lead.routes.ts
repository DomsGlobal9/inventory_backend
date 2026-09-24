import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { submitLead, sendSignupCode, checkSignupCode } from '../controllers/lead.controller';
import { env } from '../config/env';

/**
 * Far tighter than the global 100/min: this endpoint is unauthenticated and writes a row
 * that a human then has to read, so the cost of abuse is paid in the platform team's
 * attention rather than in CPU. Five an hour per address is generous for anyone filling in
 * a form once and useless for filling the console with junk.
 */
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: env.SIGNUP_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "You've already sent us a few enquiries. Please give us a little time to respond."
  }
});

/**
 * Codes are counted far more tightly than the form itself, and the service counts them PER NUMBER
 * as well: a code goes to somebody else's phone, so this must never become a way to pester a
 * stranger. Ten an hour from one address covers a person who mistypes their number twice and
 * asks again; it is useless for anything else.
 */
const codeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) > 0 ? 2000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts just now. Please wait a few minutes.' }
});

const router = Router();
router.post('/', signupLimiter, submitLead);
router.post('/verify/send', codeLimiter, sendSignupCode);
router.post('/verify/check', codeLimiter, checkSignupCode);

export default router;
