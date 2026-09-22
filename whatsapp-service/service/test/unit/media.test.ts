import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { checkMediaUrl, fetchImage, ImageCache, MediaFetchError, parseMediaPrefixes, sniffImage, MAX_IMAGE_BYTES } from '../../src/lib/media';
import { contentHash } from '../../src/domain/rules';
import { loadConfig } from '../../src/config';
import { AppError } from '../../src/lib/errors';
import { JPEG, MediaServer, PNG } from '../helpers/media-server';

const STORE = 'https://store.supabase.co/storage/v1/object/public/whatsapp-media/';

describe('MEDIA_URL_PREFIXES', () => {
  it('accepts https folders and keeps them in normal form', () => {
    expect(parseMediaPrefixes(`${STORE}, https://Other.Example.com/pics/`, true)).toEqual([STORE, 'https://other.example.com/pics/']);
    expect(parseMediaPrefixes('', true)).toEqual([]);
    expect(parseMediaPrefixes(undefined, true)).toEqual([]);
    expect(parseMediaPrefixes(' , ', true)).toEqual([]);
  });

  it('plain http only to this computer, and never in production', () => {
    expect(parseMediaPrefixes('http://127.0.0.1:9000/m/', false)).toEqual(['http://127.0.0.1:9000/m/']);
    expect(() => parseMediaPrefixes('http://127.0.0.1:9000/m/', true)).toThrow(/https/);
    expect(() => parseMediaPrefixes('http://store.supabase.co/m/', false)).toThrow(/https/);
  });

  it('refuses whole sites, files, passwords, queries and junk', () => {
    expect(() => parseMediaPrefixes('https://store.supabase.co/', true)).toThrow(/folder/);
    expect(() => parseMediaPrefixes('https://store.supabase.co', true)).toThrow(/folder/);
    expect(() => parseMediaPrefixes('https://store.supabase.co/m/a.jpg', true)).toThrow(/folder/);
    expect(() => parseMediaPrefixes('https://u:p@store.supabase.co/m/', true)).toThrow(/password/);
    expect(() => parseMediaPrefixes('https://store.supabase.co/m/?x=1', true)).toThrow(/\?/);
    expect(() => parseMediaPrefixes('not a url', true)).toThrow(/not a web address/);
    expect(() => parseMediaPrefixes('ftp://store.supabase.co/m/', true)).toThrow(/https/);
  });

  it('a bad setting stops the service at start, naming the variable', () => {
    const base = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://x/y',
      ENGINE_URL: 'engine:8080',
      ENGINE_API_KEY: 'k'.repeat(16),
      ENGINE_WEBHOOK_SECRET: 's'.repeat(24),
      ADMIN_KEY: 'a'.repeat(24),
      ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
      SCALEEZY_INSTANCE: 'scaleezy',
    };
    expect(loadConfig({ ...base, MEDIA_URL_PREFIXES: STORE }).mediaUrlPrefixes).toEqual([STORE]);
    expect(loadConfig(base).mediaUrlPrefixes).toEqual([]);
    expect(() => loadConfig({ ...base, MEDIA_URL_PREFIXES: 'https://store.supabase.co/' })).toThrow(/MEDIA_URL_PREFIXES: .*folder/);
  });
});

describe('picture addresses from modules', () => {
  const ok = (u: string) => checkMediaUrl(u, [STORE], true);
  const refused = (u: string, prefixes: string[] = [STORE]) => {
    try {
      checkMediaUrl(u, prefixes, true);
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).status).toBe(400);
      return (e as AppError).message;
    }
    throw new Error(`accepted: ${u}`);
  };

  it('accepts a file inside the folder, in normal form', () => {
    expect(ok(`${STORE}m/8f3c.jpg`)).toBe(`${STORE}m/8f3c.jpg`);
    expect(ok('HTTPS://STORE.supabase.co/storage/v1/object/public/whatsapp-media/a.jpg')).toBe(`${STORE}a.jpg`);
  });

  it('refuses everything outside the folder', () => {
    expect(refused('https://evil.example.com/whatsapp-media/a.jpg')).toMatch(/picture storage/);
    expect(refused('https://store.supabase.co/storage/v1/object/public/other-bucket/a.jpg')).toMatch(/picture storage/);
    // A look-alike host that starts with the real one.
    expect(refused('https://store.supabase.co.evil.com/storage/v1/object/public/whatsapp-media/a.jpg')).toMatch(/picture storage/);
    // The folder itself is not a picture.
    expect(refused(STORE)).toMatch(/picture storage/);
    // Climbing out with ../ is folded by the URL parser and then lands outside.
    expect(refused(`${STORE}../private/a.jpg`)).toMatch(/picture storage/);
  });

  it('refuses tricks inside the folder', () => {
    // The URL parser itself reads %2e%2e as .. and folds it, which lands outside the folder.
    expect(refused(`${STORE}%2e%2e/private/a.jpg`)).toMatch(/not allowed|picture storage/);
    expect(refused(`${STORE}..%2Fprivate%2Fa.jpg`)).toMatch(/not allowed/);
    expect(refused(`${STORE}a%5c..%5cb.jpg`)).toMatch(/not allowed/);
    expect(refused(`${STORE}a.jpg?download=1`)).toMatch(/\?/);
    expect(refused(`${STORE}a.jpg#x`)).toMatch(/#/);
    expect(refused('https://u:p@store.supabase.co/storage/v1/object/public/whatsapp-media/a.jpg')).toMatch(/password/);
    expect(refused(`http://store.supabase.co/storage/v1/object/public/whatsapp-media/a.jpg`)).toMatch(/https/);
    expect(refused('javascript:alert(1)')).toMatch(/https/);
    expect(refused('not a url')).toMatch(/not a web address/);
    expect(refused(`${STORE}${'a'.repeat(2100)}.jpg`)).toMatch(/too long/);
  });

  it('with no folder set up, pictures cannot be sent at all', () => {
    expect(refused(`${STORE}a.jpg`, [])).toMatch(/no picture storage/);
  });
});

describe('picture type', () => {
  it('tells JPEG and PNG by their first bytes, and nothing else', () => {
    expect(sniffImage(JPEG)).toBe('image/jpeg');
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from('GIF89a......'))).toBeNull();
    expect(sniffImage(Buffer.from('RIFF....WEBPVP8 '))).toBeNull();
    expect(sniffImage(Buffer.from('%PDF-1.4'))).toBeNull();
    expect(sniffImage(Buffer.from('<html>'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
    expect(sniffImage(Buffer.from([0xff, 0xd8]))).toBeNull();
  });
});

describe('content hash', () => {
  it('a message without a picture hashes exactly as before pictures existed', () => {
    const old = (text: string, doc: Buffer | null) => {
      const h = createHash('sha256');
      h.update('t:');
      h.update(text, 'utf8');
      h.update('|d:');
      if (doc) h.update(createHash('sha256').update(doc).digest('hex'));
      return h.digest('hex');
    };
    expect(contentHash('hello', null)).toBe(old('hello', null));
    expect(contentHash('hello', null, null)).toBe(old('hello', null));
    expect(contentHash('bill', Buffer.from('%PDF-1'))).toBe(old('bill', Buffer.from('%PDF-1')));
  });

  it('the picture counts: same words with another picture is another message', () => {
    const a = contentHash('Diwali offer', null, `${STORE}a.jpg`);
    expect(a).toBe(contentHash('Diwali offer', null, `${STORE}a.jpg`));
    expect(a).not.toBe(contentHash('Diwali offer', null, `${STORE}b.jpg`));
    expect(a).not.toBe(contentHash('Diwali offer', null));
  });
});

describe('fetching a picture', () => {
  const media = new MediaServer();
  beforeAll(() => media.start());
  afterAll(() => media.stop());
  beforeEach(() => media.reset());

  const failure = async (url: string, opts?: Parameters<typeof fetchImage>[1]) => {
    try {
      await fetchImage(url, opts);
    } catch (e) {
      expect(e).toBeInstanceOf(MediaFetchError);
      return e as MediaFetchError;
    }
    throw new Error('fetched');
  };

  it('fetches a JPEG and a PNG', async () => {
    const j = await fetchImage(media.put('a.jpg', { kind: 'file', body: JPEG }));
    expect(j.mimeType).toBe('image/jpeg');
    expect(j.bytes.equals(JPEG)).toBe(true);
    // The declared type does not matter; the bytes do.
    const p = await fetchImage(media.put('b.bin', { kind: 'file', body: PNG, contentType: 'application/octet-stream' }));
    expect(p.mimeType).toBe('image/png');
  });

  it('gone, moved, not a picture or empty: fails for good', async () => {
    expect((await failure(media.url('missing.jpg'))).transient).toBe(false);
    expect((await failure(media.put('gone.jpg', { kind: 'status', status: 403 }))).transient).toBe(false);
    const moved = await failure(media.put('moved.jpg', { kind: 'redirect', to: 'https://evil.example.com/x.jpg' }));
    expect(moved.transient).toBe(false);
    expect(moved.message).toMatch(/somewhere else/);
    const html = await failure(media.put('page.jpg', { kind: 'file', body: Buffer.from('<html>login</html>'), contentType: 'image/jpeg' }));
    expect(html.transient).toBe(false);
    expect(html.message).toMatch(/not a JPEG or PNG/);
    expect((await failure(media.put('empty.jpg', { kind: 'file', body: Buffer.alloc(0) }))).message).toMatch(/empty/);
  });

  it('too big: refused by the declared size, and while reading when no size is declared', async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    const declared = await failure(media.put('big.jpg', { kind: 'file', body: big }));
    expect(declared.transient).toBe(false);
    expect(declared.message).toMatch(/5 MB/);
    const streamed = await failure(media.put('big2.jpg', { kind: 'file', body: big, noLength: true }));
    expect(streamed.transient).toBe(false);
    expect(streamed.message).toMatch(/5 MB/);
  });

  it('storage down, slow, overloaded or cut off: try again later', async () => {
    expect((await failure(media.put('e500.jpg', { kind: 'status', status: 503 }))).transient).toBe(true);
    expect((await failure(media.put('e429.jpg', { kind: 'status', status: 429 }))).transient).toBe(true);
    expect((await failure(media.put('slow.jpg', { kind: 'slow', ms: 2000, body: JPEG }), { timeoutMs: 200 })).transient).toBe(true);
    expect((await failure(media.put('cut.jpg', { kind: 'cut', body: JPEG }))).transient).toBe(true);
    expect((await failure('http://127.0.0.1:1/whatsapp-media/a.jpg')).transient).toBe(true);
  });
});

describe('picture cache', () => {
  const img = (n: number) => ({ bytes: Buffer.from([n]), mimeType: 'image/jpeg' as const });

  it('keeps the most recently used, up to its size', () => {
    const c = new ImageCache(2);
    c.set('a', img(1));
    c.set('b', img(2));
    expect(c.get('a')?.bytes[0]).toBe(1); // a is now the most recent
    c.set('c', img(3)); // b goes
    expect(c.get('b')).toBeNull();
    expect(c.get('a')?.bytes[0]).toBe(1);
    expect(c.get('c')?.bytes[0]).toBe(3);
    expect(c.size).toBe(2);
  });

  it('forgets a picture after its time', () => {
    let now = 0;
    const c = new ImageCache(8, 1000, () => now);
    c.set('a', img(1));
    now = 999;
    expect(c.get('a')).not.toBeNull();
    now = 2100;
    expect(c.get('a')).toBeNull();
    expect(c.size).toBe(0);
  });
});
