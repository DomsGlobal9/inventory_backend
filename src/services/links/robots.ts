/**
 * Person or robot? Decides only how an open is COUNTED -- never whether the link works.
 *
 * WhatsApp opens every link itself to build the preview card, before anyone taps it, and so do
 * other apps, mail scanners and search engines. Counting those as taps would make every campaign
 * look clicked. The rules live here, in one place, so a new previewer is one line.
 *
 * When unsure, the open counts as a person: a missed robot inflates a number a little; a person
 * wrongly called a robot would hide real interest from the shop.
 */

/** Words in a browser string that only robots use. Matched case-insensitively. */
export const ROBOT_MARKERS: readonly string[] = [
  // Link previews in chat apps
  // (Not "Teams", "Viber" or "Snapchat": people open links inside those apps' own browsers too.)
  'whatsapp', 'facebookexternalhit', 'facebot', 'meta-externalagent', 'telegrambot', 'twitterbot', 'slackbot',
  'slack-imgproxy', 'discordbot', 'linkedinbot', 'skypeuripreview', 'pinterestbot',
  'redditbot', 'embedly', 'iframely', 'microsoftpreview', 'google-pagerenderer', 'googleother',
  // Search engines and crawlers
  'googlebot', 'bingbot', 'applebot', 'yandex', 'baiduspider', 'duckduckbot', 'petalbot', 'ahrefsbot',
  'semrushbot', 'mj12bot', 'dotbot', 'bytespider', 'gptbot', 'claudebot', 'ccbot', 'perplexitybot',
  // Security scanners that open links in mail and chats
  'barracuda', 'proofpoint', 'mimecast', 'safelinks', 'urlscan', 'virustotal', 'phishtank',
  // Programs rather than people
  'curl/', 'wget/', 'python-requests', 'python-urllib', 'aiohttp', 'go-http-client', 'java/', 'okhttp',
  'axios/', 'node-fetch', 'undici', 'libwww-perl', 'httpclient', 'headlesschrome', 'phantomjs'
];

/**
 * The words robots use about themselves: "Somebot/1.0", "(compatible; crawler)", "link preview".
 * Whole words or name/version only, so a phone called "CUBOT X30" is still a person.
 */
const ROBOT_WORDS = [/[a-z0-9-]*(bot|crawler|spider)\/\d/, /\b(bot|robot|crawler|spider|scanner|preview|fetcher)\b/];

export type Visitor = 'HUMAN' | 'BOT';

export function classifyVisitor(method: string, userAgent: string | undefined | null): Visitor {
  // A HEAD asks "what is there" without looking: previewers and checkers do that, people do not.
  if (method.toUpperCase() === 'HEAD') return 'BOT';
  const ua = (userAgent ?? '').trim().toLowerCase();
  // Every browser a person uses sends one.
  if (!ua) return 'BOT';
  return ROBOT_MARKERS.some(m => ua.includes(m)) || ROBOT_WORDS.some(r => r.test(ua)) ? 'BOT' : 'HUMAN';
}
