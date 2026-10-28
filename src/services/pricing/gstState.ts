/**
 * Which GST state an address is in, as the two-digit code GST uses ("33" for Tamil Nadu).
 *
 * The place of supply decides the split: the shop's own state is CGST + SGST, any other is IGST.
 * Addresses come from outside (Shopify, a storefront) spelt their own way -- Shopify sends an
 * Indian state as a short code ("TN", "KA") and its name ("Tamil Nadu"), and older states have
 * more than one code ("OR" and "OD" for Odisha). Every spelling we know of is listed; anything
 * else answers null, and the caller treats null as "the shop's own state" and says so.
 *
 * PURE: no database, no network.
 */

/** GSTN's list, code to name (the same as frontend utils/gstStates.js). */
export const GST_STATE_NAMES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland',
  '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory'
};

/** GST's code for a place outside India: an export, always IGST. */
export const FOREIGN_STATE_CODE = '96';

/** Short state codes as Shopify (and ISO 3166-2:IN) write them, old and new. */
const SHORT: Record<string, string> = {
  JK: '01', HP: '02', PB: '03', CH: '04', UK: '05', UT: '05', HR: '06', DL: '07', RJ: '08', UP: '09',
  BR: '10', SK: '11', AR: '12', NL: '13', MN: '14', MZ: '15', TR: '16', ML: '17', AS: '18', WB: '19',
  JH: '20', OR: '21', OD: '21', CG: '22', CT: '22', MP: '23', GJ: '24', DD: '26', DN: '26', DH: '26',
  MH: '27', KA: '29', GA: '30', LD: '31', KL: '32', TN: '33', PY: '34', AN: '35', TS: '36', TG: '36',
  AP: '37', LA: '38'
};

const squash = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');

/** Names, and the old names people still type. */
const BY_NAME: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [code, name] of Object.entries(GST_STATE_NAMES)) out[squash(name)] = code;
  Object.assign(out, {
    orissa: '21', pondicherry: '34', uttaranchal: '05', newdelhi: '07', nctofdelhi: '07',
    daman: '26', damananddiu: '26', dadraandnagarhaveli: '26', andamanandnicobar: '35', jammuandkashmirut: '01'
  });
  return out;
})();

export function gstStateCodeOf(a: { countryCode?: string | null; provinceCode?: string | null; province?: string | null } | null | undefined): string | null {
  if (!a) return null;
  const country = String(a.countryCode ?? '').trim().toUpperCase();
  if (country && country !== 'IN') return FOREIGN_STATE_CODE;

  const code = String(a.provinceCode ?? '').trim().toUpperCase().replace(/^IN-/, '');
  if (/^\d{2}$/.test(code) && GST_STATE_NAMES[code]) return code;
  if (SHORT[code]) return SHORT[code];

  const name = squash(String(a.province ?? ''));
  if (name && BY_NAME[name]) return BY_NAME[name];
  return null;
}
