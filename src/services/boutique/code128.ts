/**
 * Code 128 (set B), the barcode Inventory prints on every label (INTERNAL_CODE128), drawn on the server for label
 * sheets made through the boutique API. No dependency: the standard pattern table, checksum and stop.
 * Proved bar for bar against JsBarcode (what the Inventory app prints with) in verify-boutique-labels.
 */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112'
];
const START_B = 104;
const STOP = 106;

/** Whether a value can be drawn in Code 128 set B: printable ASCII only, 1 to 48 characters. */
export const encodable = (value: string) => /^[\x20-\x7E]{1,48}$/.test(value);

/** The bars and spaces as a string of 1 (bar) and 0 (space), one character per module. */
export function code128B(value: string): string {
  if (!encodable(value)) throw new Error('A barcode can hold letters, digits and simple signs only, up to 48.');
  const codes = [START_B, ...[...value].map(ch => ch.charCodeAt(0) - 32)];
  const checksum = codes.reduce((sum, c, i) => sum + c * (i === 0 ? 1 : i), 0) % 103;
  let out = '';
  for (const c of [...codes, checksum, STOP]) {
    [...PATTERNS[c]].forEach((w, i) => { out += (i % 2 === 0 ? '1' : '0').repeat(Number(w)); });
  }
  return out;
}
