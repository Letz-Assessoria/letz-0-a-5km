// Servidor falso do Asaas para testes e e2e (só node:http, sem dependências).
//
// Uso direto:  node tests/fake-asaas.mjs            (porta 7777, ou FAKE_ASAAS_PORT)
// Uso em teste: const { startFakeAsaas } = await import('./fake-asaas.mjs');
//               const fake = await startFakeAsaas({ port: 0 }); ... await fake.close();
//
// Imita (baseUrl = http://127.0.0.1:7777/v3):
//   POST /v3/checkouts              → 200 {id, link, status: 'ACTIVE', ...}  (500 no modo falha)
//   POST /v3/checkouts/:id/cancel   → 200 {id, status: 'CANCELED'} | 404
//   Exige o cabeçalho access_token (qualquer valor não vazio), senão 401.
// Controle:
//   POST /__emit   {target, token, body} → envia body por POST ao target com o cabeçalho
//                  asaas-access-token: token; responde {status, text} do alvo.
//   POST /__fail   {checkouts: true|false} → liga/desliga o 500 em POST /v3/checkouts.
//   POST /__delay  {checkouts: ms} → atrasa POST /v3/checkouts (para testar corridas).
//   GET  /__checkouts → lista de checkouts criados (com externalReference e status).
//   POST /__reset  → limpa checkouts e desliga o modo falha e o atraso.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function parse(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}

export function startFakeAsaas({ port = Number(process.env.FAKE_ASAAS_PORT) || 7777, host = '127.0.0.1' } = {}) {
  const state = { checkouts: new Map(), failCheckouts: false, delayCheckouts: 0 };
  let origin = '';

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      const text = await readBody(req);

      // Controle
      if (p === '/__emit' && req.method === 'POST') {
        const { target, token, body } = parse(text) || {};
        if (!target || body === undefined) return send(res, 400, { error: 'target e body obrigatórios' });
        const headers = { 'content-type': 'application/json' };
        if (token) headers['asaas-access-token'] = token;
        try {
          const r = await fetch(target, { method: 'POST', headers, body: JSON.stringify(body) });
          return send(res, 200, { status: r.status, text: await r.text() });
        } catch (err) {
          return send(res, 502, { error: String(err && err.message) });
        }
      }
      if (p === '/__fail' && req.method === 'POST') {
        const b = parse(text) || {};
        state.failCheckouts = Boolean(b.checkouts);
        return send(res, 200, { failCheckouts: state.failCheckouts });
      }
      if (p === '/__delay' && req.method === 'POST') {
        const b = parse(text) || {};
        state.delayCheckouts = Math.max(0, Number(b.checkouts) || 0);
        return send(res, 200, { delayCheckouts: state.delayCheckouts });
      }
      if (p === '/__checkouts' && req.method === 'GET') {
        return send(res, 200, [...state.checkouts.values()]);
      }
      if (p === '/__reset' && req.method === 'POST') {
        state.checkouts.clear();
        state.failCheckouts = false;
        state.delayCheckouts = 0;
        return send(res, 200, { ok: true });
      }

      // API imitada
      if (p.startsWith('/v3/')) {
        if (!req.headers['access_token']) {
          return send(res, 401, { errors: [{ code: 'invalid_access_token', description: 'Chave ausente.' }] });
        }
        if (p === '/v3/checkouts' && req.method === 'POST') {
          if (state.delayCheckouts) await new Promise((r) => setTimeout(r, state.delayCheckouts));
          if (state.failCheckouts) {
            return send(res, 500, { errors: [{ code: 'internal_error', description: 'Falha simulada do Asaas.' }] });
          }
          const b = parse(text);
          if (!b) return send(res, 400, { errors: [{ code: 'invalid_object', description: 'JSON inválido.' }] });
          const id = randomUUID();
          const checkout = {
            id,
            link: `${origin}/checkoutSession/show/${id}`,
            status: 'ACTIVE',
            minutesToExpire: b.minutesToExpire ?? null,
            externalReference: b.externalReference ?? null,
            billingTypes: b.billingTypes ?? [],
            chargeTypes: b.chargeTypes ?? [],
            callback: b.callback ?? null,
            installment: b.installment ?? null,
            customerData: b.customerData ?? null,
            items: (b.items || []).map(({ imageBase64, ...rest }) => rest),
          };
          state.checkouts.set(id, checkout);
          return send(res, 200, checkout);
        }
        const m = p.match(/^\/v3\/checkouts\/([^/]+)\/cancel$/);
        if (m && req.method === 'POST') {
          const c = state.checkouts.get(decodeURIComponent(m[1]));
          if (!c) return send(res, 404, { errors: [{ code: 'not_found', description: 'Checkout não encontrado.' }] });
          c.status = 'CANCELED';
          return send(res, 200, c);
        }
      }

      // Página de checkout falsa, para o navegador do e2e não cair em 404.
      const show = p.match(/^\/checkoutSession\/show\/([^/]+)$/);
      if (show && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><meta charset="utf-8"><title>Checkout falso</title><h1>Checkout falso ${show[1]}</h1>`);
      }

      send(res, 404, { errors: [{ code: 'not_found', description: `${req.method} ${p}` }] });
    } catch (err) {
      send(res, 500, { errors: [{ code: 'fake_error', description: String(err && err.message) }] });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      origin = `http://${host}:${actual}`;
      resolve({
        port: actual,
        url: origin,
        state,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const fake = await startFakeAsaas();
  console.log(`fake-asaas ouvindo em ${fake.url} (baseUrl ${fake.url}/v3)`);
}
