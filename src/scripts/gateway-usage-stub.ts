// A local stand-in for the Gateway, answering like the documented routes on feat/catalog-billing:
//   POST /api/v1/draping/cancel-job   key check (404 "no job" = key accepted, 401 = rejected)
//   GET  /api/v1/usage?month=YYYY-MM  the caller's own month, amounts in paise + rupee strings
//   GET  /__hits                      how many usage calls each key made (for the cache check)
// Keys: sek_test_on_*  -> billing on; sek_test_off_* -> 404 (billing not deployed); sek_test_bad_* -> 500 garbage
import http from 'node:http';

const send = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export function startGatewayUsageStub(port = 4099): Promise<{ hits: Record<string, number>; close: () => Promise<void> }> {
  const hits: Record<string, number> = {};

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const key = String(req.headers['x-api-key'] || '');
    if (url.pathname === '/__hits') return send(res, 200, hits);
    if (url.pathname === '/__reset') { for (const k of Object.keys(hits)) delete hits[k]; return send(res, 200, {}); }

    if (req.method === 'POST' && url.pathname === '/api/v1/draping/cancel-job') {
      return key.startsWith('sek_test_') ? send(res, 404, { error: 'no job' }) : send(res, 401, { error: 'bad key' });
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/usage') {
      hits[key] = (hits[key] || 0) + 1;
      if (!key.startsWith('sek_test_')) return send(res, 401, { error: { code: 'INVALID_API_KEY', message: 'bad key' } });
      if (key.startsWith('sek_test_off_')) return send(res, 404, { error: 'Not found' });
      if (key.startsWith('sek_test_bad_')) { res.writeHead(500); return res.end('<html>oops</html>'); }
      const month = url.searchParams.get('month');
      // 3 catalogs x Rs 249 + 2 colour variants x Rs 149 = Rs 1,045.00; GST 18% = Rs 188.10; total Rs 1,233.10
      return send(res, 200, {
        month, from: `${month}-01T00:00:00.000Z`, to: null, currency: 'INR',
        catalogs: 3, colourVariants: 2,
        lines: [
          { kind: 'CATALOG', description: 'Four-view catalog', quantity: 3, unitPrice: { paise: 24900, rupees: '249.00' }, amount: { paise: 74700, rupees: '747.00' } },
          { kind: 'COLOUR_VARIANT', description: 'Colour variant', quantity: 2, unitPrice: { paise: 14900, rupees: '149.00' }, amount: { paise: 29800, rupees: '298.00' } }
        ],
        subtotal: { paise: 104500, rupees: '1045.00' },
        gst: { ratePercent: 18, amount: { paise: 18810, rupees: '188.10' } },
        total: { paise: 123310, rupees: '1233.10' },
        monthlyLimit: null,
        runs: []
      });
    }
    send(res, 404, { error: 'Not found' });
  });
  return new Promise(resolve => server.listen(port, () => resolve({ hits, close: () => new Promise<void>(r => server.close(() => r())) })));
}
