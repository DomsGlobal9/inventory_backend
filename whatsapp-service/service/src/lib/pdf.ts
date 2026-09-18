import { AppError, Errors } from './errors';

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** Decodes and checks an uploaded document. Throws a plain-English AppError when it is refused. */
export function decodePdf(base64: string, mimeType: string): Buffer {
  if (mimeType !== 'application/pdf') throw Errors.badRequest('Only PDF documents can be sent.');
  // Reject anything that is not base64 before decoding (Buffer.from silently skips junk).
  const clean = base64.replace(/^data:application\/pdf;base64,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw Errors.badRequest('The document could not be read. Please attach the PDF again.');
  // Size check on the encoded length first, so a huge upload is never fully decoded.
  if (Math.floor((clean.length * 3) / 4) > MAX_DOCUMENT_BYTES + 3) throw tooLarge();
  const buf = Buffer.from(clean, 'base64');
  if (buf.length === 0) throw Errors.badRequest('The document is empty.');
  if (buf.length > MAX_DOCUMENT_BYTES) throw tooLarge();
  if (!isPdf(buf)) throw Errors.badRequest('This file is not a PDF. Only PDF documents can be sent.');
  return buf;
}

export function isPdf(buf: Buffer): boolean {
  return buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

function tooLarge(): AppError {
  return Errors.tooLarge('This PDF is larger than 5 MB. Please make it smaller and try again.');
}
