import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { submitLead } from '../controllers/lead.controller';
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

const router = Router();
router.post('/', signupLimiter, submitLead);

export default router;
