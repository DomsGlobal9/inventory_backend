/**
 * Proving the phone number on a signup enquiry, with a code sent on WhatsApp from ScaleEzy's own
 * number. Its own module: nothing else reads or writes `signup_phone_codes`.
 */
export * as signupVerify from './otp';
export { SignupVerifyError } from './otp';
