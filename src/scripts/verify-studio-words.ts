// The photo studio's errors in the shop's words (26 Nov 2026): no field names, HTTP codes or capital codes on screen.
import { studioWords } from '../services/photo-jobs/runner';
const cases: [any, RegExp][] = [
  [{ code: 'SAREE_EXTRA_MISMATCH', error: 'Extra photo 2 (sareeExtras) shows a different saree from the main photo.', details: [{ extra: 2 }] }, /^Extra photo 2 shows a different saree/],
  [{ error: 'Extra photo 2 (sareeExtras): an image link could not be downloaded (HTTP 404).' }, /^Extra photo 2 could not be opened/],
  [{ error: 'The saree photo (saree): an image link could not be downloaded (HTTP 404).' }, /^The main photo could not be opened/],
  [{ error: 'The blouse photo (blouse): a photo that cannot be read.' }, /^The blouse photo could not be opened/],
  [{ error: 'The front view (frontView): an image link could not be downloaded (HTTP 500).' }, /^The front view could not be opened/],
  [{ code: 'AI_LIMIT_REACHED', error: 'Provider quota exceeded' }, /busy just now/],
  [{ error: 'Pipeline step 3 failed: undefined is not a function' }, /^The photo studio could not finish this one/],
  [{ error: 'INVALID_SAREE_EXTRAS: not a list' }, /^The photo studio could not finish this one/],
  [{ error: 'The saree could not be draped this time. Please try again.' }, /^The saree could not be draped this time/],
  [{}, /^The photo studio could not finish this one/],
];
// Refusals before anything is made (the gateway's JSON), 26 Nov 2026.
import { studioRefusal } from '../services/photo-jobs/runner';
const refusals: [number, string, RegExp][] = [
  [402, JSON.stringify({ error: { code: 'MONTHLY_LIMIT_REACHED', message: "This month's limit is reached. Ask ScaleEzy to raise it." } }), /^This month's photo limit is used up.*Ask ScaleEzy to raise the limit/],
  [429, JSON.stringify({ error: 'Generation limit reached: 20 per hour. Retry in 1200s.', retryAfterSec: 1200 }), /^The hourly limit for making photos is used up.*in about 20 minutes/],
  [429, JSON.stringify({ error: 'Service at capacity. Please retry shortly.', retryAfterSec: 30 }), /^The photo studio is busy just now.*in a minute/],
  [401, JSON.stringify({ error: 'Invalid API key' }), /^Making photos is not set up for this shop yet/],
  [502, '<html>Bad gateway</html>', /^The photo studio could not be reached just now/],
];
let bad = 0;
for (const [status, body, want] of refusals) {
  const got = studioRefusal(status, body);
  const ok = want.test(got) && !/HTTP|API key|retryAfter|[A-Z]{2,}_[A-Z]/.test(got);
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'} refusal ${status} -> ${got}`);
}
for (const [input, want] of cases) { const got = studioWords(input); const ok = want.test(got); if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'} ${JSON.stringify(input.error ?? input.code ?? '(empty)').slice(0, 60)} -> ${got}`); }
console.log(bad ? `${bad} FAILED` : 'ALL PASSED'); process.exit(bad ? 1 : 0);
