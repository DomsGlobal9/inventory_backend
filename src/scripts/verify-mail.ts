/**
 * Checks the mail setup without emailing anyone by accident.
 *
 * Two modes, because they answer different questions:
 *
 *   npx ts-node src/scripts/verify-mail.ts                    settings only -- connects and
 *                                                             authenticates, sends nothing
 *   npx ts-node src/scripts/verify-mail.ts you@example.com    sends one real message there
 *
 * The default is the safe one on purpose. "Verify the mail config" should never be a command
 * that mails somebody.
 */
import { mailService } from '../services/mail.service';
import { env } from '../config/env';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) { passed++; console.log(`  [PASS] ${name}`); }
  else { failed++; console.log(`  [FAIL] ${name}${detail ? `  -> ${detail}` : ''}`); }
};

async function main() {
  const recipient = process.argv[2];

  console.log('\nCONFIGURATION');
  console.log(`  host      ${env.EMAIL_HOST ?? '(not set)'}`);
  console.log(`  port      ${env.EMAIL_PORT}`);
  console.log(`  user      ${env.EMAIL_HOST_USER ?? '(not set)'}`);
  // Presence only. The password never appears in output, and this script is run on servers
  // where the output ends up in a log.
  console.log(`  password  ${env.EMAIL_HOST_PASSWORD ? 'set' : '(not set)'}`);
  console.log(`  from      ${env.EMAIL_FROM_NAME} <${env.EMAIL_FROM_ADDRESS ?? env.EMAIL_HOST_USER ?? '?'}>`);

  console.log('\nIS IT USABLE');
  const configured = mailService.isConfigured();
  check('the deployment reports whether email is set up', typeof configured === 'boolean');

  if (!configured) {
    // Not a failure. Running without email is a supported state, and the point of this script
    // is to say so clearly rather than to insist.
    console.log('\n  Email is not configured here. Set EMAIL_HOST, EMAIL_HOST_USER and');
    console.log('  EMAIL_HOST_PASSWORD to enable it. Credential sharing keeps working through');
    console.log('  the WhatsApp and copy options in the meantime.');
    console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
    return;
  }

  console.log('\nCAN WE ACTUALLY CONNECT AND SIGN IN');
  const verified = await mailService.verify();
  check('the mail server accepts our settings', verified.sent, verified.reason);

  if (!verified.sent) {
    console.log('\n  Nothing was sent. Fix the above first.');
    console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
    process.exitCode = 1;
    return;
  }

  if (!recipient) {
    console.log('\n  Settings are good. To send a real test message:');
    console.log('    npx ts-node src/scripts/verify-mail.ts you@example.com');
    console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
    return;
  }

  console.log('\nA REAL MESSAGE');
  // Deliberately the credential template rather than a bespoke "test" body: what this proves
  // is then what will actually be sent in production. A special test path can pass while the
  // real one renders badly or trips a spam filter.
  const sent = await mailService.sendCredentials({
    recipientName: 'Test Recipient',
    email: recipient,
    password: 'not-a-real-password-0000',
    roleLabel: 'TEST'
  });
  check(`a credential email reaches ${recipient}`, sent.sent, sent.reason);
  if (sent.sent) console.log('\n  Check the inbox, and the spam folder if it is not there.');

  console.log(`\n================ RESULT: ${passed} passed | ${failed} failed ================`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error('\nSuite crashed:', error); process.exitCode = 1; });
