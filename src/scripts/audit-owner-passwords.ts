/**
 * READ ONLY. For recent logins: does the password the Console can reveal match the one login checks against?
 * Written for the owner's report of 5 Nov ("after onboarding I can't log in with that password, only after a reset").
 * Prints yes/no and counts only: never a password, a hash or an email. Run where the database is, in Render's Shell:
 *   npx tsx src/scripts/audit-owner-passwords.ts
 * A MISMATCH on an account nobody has reset would mean onboarding really stored two different passwords.
 */
import { prisma } from '../lib/prisma';
import { AuthService } from '../services/auth.service';
import { decryptCredential } from '../lib/credentialEncryption';

(async () => {
  const users = await prisma.user.findMany({
    where: { passwordEncrypted: { not: null } }, orderBy: { createdAt: 'desc' }, take: 40,
    select: { clientId: true, email: true, password: true, passwordEncrypted: true, sessionVersion: true, createdAt: true, lastActiveAt: true }
  });
  let match = 0, mismatch = 0, unreadable = 0, capitals = 0, dash = 0, lookalike = 0;
  for (const u of users) {
    let verdict: string;
    try {
      const plain = decryptCredential(u.passwordEncrypted as string);
      const same = await AuthService.comparePassword(plain, u.password);
      verdict = same ? 'match' : 'MISMATCH';
      if (same) match++; else mismatch++;
      if (plain.includes('-')) dash++;
      if (/[lI1O0]/.test(plain)) lookalike++;
    } catch { verdict = 'UNREADABLE'; unreadable++; }
    const caps = u.email !== u.email.toLowerCase();
    if (caps) capitals++;
    console.log(`${u.createdAt.toISOString().slice(0, 10)} ${String(u.clientId).slice(0, 28).padEnd(28)} resets/sign-outs=${u.sessionVersion} signed-in=${u.lastActiveAt ? 'yes' : 'no '} ${verdict}${caps ? ' email-has-capitals' : ''}`);
  }
  console.log(JSON.stringify({ checked: users.length, match, mismatch, unreadable, emailsWithCapitals: capitals, passwordsWithDash: dash, passwordsWithLookalikes: lookalike }));
  await prisma.$disconnect();
})().catch(e => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
