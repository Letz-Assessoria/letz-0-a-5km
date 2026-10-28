// Testes do cliente do Asaas (functions/src/asaas.js) e do servidor falso (tests/fake-asaas.mjs).
// Não usam rede nem emulador: o fetch é falso ou aponta para o servidor falso local.
// Os corpos de webhook vêm de fixtures/asaas-events.json, capturados no sandbox (ver docs/asaas-notas.md).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { createClient, classifyEvent } = require('../../functions/src/asaas.js');
const events = JSON.parse(readFileSync(new URL('./fixtures/asaas-events.json', import.meta.url), 'utf8'));

const BASE = 'https://api-sandbox.asaas.com/v3';
const KEY = 'chave-falsa-de-teste';

function fakeFetch(responseBody, status = 200) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(responseBody), { status, headers: { 'content-type': 'application/json' } });
  };
  return { impl, calls };
}

const CHECKOUT_ARGS = {
  uid: 'uid-123',
  value: 159,
  maxInstallments: 12,
  successUrl: 'https://letz-0-aos-5km.web.app/#/pagamento',
  cancelUrl: 'https://letz-0-aos-5km.web.app/#/pagamento?c=cancel',
  expiredUrl: 'https://letz-0-aos-5km.web.app/#/pagamento?c=expired',
  minutesToExpire: 60,
};

describe('createCheckout', () => {
  it('createCheckout envia value 159 e maxInstallments 12 e devolve url', async () => {
    const { impl, calls } = fakeFetch({
      id: '121ab2db-988e-4418-9d5d-45a58638ba01',
      link: 'https://sandbox.asaas.com/000/checkoutSession/show/121ab2db-988e-4418-9d5d-45a58638ba01',
      status: 'ACTIVE',
      minutesToExpire: 60,
      externalReference: 'uid-123',
    });
    const client = createClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl });
    const before = Date.now();
    const out = await client.createCheckout(CHECKOUT_ARGS);

    assert.equal(calls.length, 1);
    const { url, init, body } = calls[0];
    assert.equal(url, `${BASE}/checkouts`);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.access_token, KEY);
    assert.ok(init.headers['User-Agent']);
    assert.equal(init.headers['Content-Type'], 'application/json');

    assert.deepEqual(body.billingTypes.slice().sort(), ['CREDIT_CARD', 'PIX']);
    assert.deepEqual(body.chargeTypes.slice().sort(), ['DETACHED', 'INSTALLMENT']);
    assert.equal(body.externalReference, 'uid-123');
    assert.deepEqual(body.installment, { maxInstallmentCount: 12 });
    assert.equal(body.minutesToExpire, 60);
    assert.deepEqual(body.callback, {
      successUrl: CHECKOUT_ARGS.successUrl,
      cancelUrl: CHECKOUT_ARGS.cancelUrl,
      expiredUrl: CHECKOUT_ARGS.expiredUrl,
    });
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].name, 'Do 0 aos 5 km');
    assert.equal(body.items[0].value, 159);
    assert.equal(body.items[0].quantity, 1);
    assert.ok(body.items[0].imageBase64.length > 100, 'imageBase64 do item');
    assert.equal(Buffer.from(body.items[0].imageBase64, 'base64').subarray(1, 4).toString(), 'PNG');
    assert.equal(body.customer, undefined, 'sem customer (Checkout exigiria endereço)');
    assert.equal(body.customerData, undefined, 'sem customerData (Checkout exigiria endereço)');

    assert.equal(out.id, '121ab2db-988e-4418-9d5d-45a58638ba01');
    assert.equal(out.url, 'https://sandbox.asaas.com/000/checkoutSession/show/121ab2db-988e-4418-9d5d-45a58638ba01');
    const exp = Date.parse(out.expiresAt);
    assert.ok(exp >= before + 60 * 60000 && exp <= Date.now() + 60 * 60000, 'expiresAt = agora + minutesToExpire');
  });

  it('createCheckout aceita nome e descrição do item (medalha) e mantém os do programa por padrão', async () => {
    const { impl, calls } = fakeFetch({ id: 'c1', link: 'https://x/c1' });
    const client = createClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl });
    await client.createCheckout({ ...CHECKOUT_ARGS, itemName: 'Medalha Letz bora!', itemDescription: 'Frete da medalha de conclusão' });
    await client.createCheckout(CHECKOUT_ARGS);
    assert.equal(calls[0].body.items[0].name, 'Medalha Letz bora!');
    assert.equal(calls[0].body.items[0].description, 'Frete da medalha de conclusão');
    assert.equal(calls[1].body.items[0].name, 'Do 0 aos 5 km');
    await assert.rejects(client.createCheckout({ ...CHECKOUT_ARGS, itemName: 'x'.repeat(31) }), /itemName/);
  });

  it('createCheckout com erro do Asaas lança erro com status e descrição, sem a chave', async () => {
    const { impl } = fakeFetch({ errors: [{ code: 'invalid_object', description: 'Campo inválido.' }] }, 400);
    const client = createClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl });
    await assert.rejects(client.createCheckout(CHECKOUT_ARGS), (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /Campo inválido/);
      assert.doesNotMatch(err.message, new RegExp(KEY));
      return true;
    });
  });

  it('createCheckout recusa parcelas fora de 1..12 e valor inválido', async () => {
    const { impl, calls } = fakeFetch({});
    const client = createClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl });
    await assert.rejects(client.createCheckout({ ...CHECKOUT_ARGS, maxInstallments: 13 }));
    await assert.rejects(client.createCheckout({ ...CHECKOUT_ARGS, value: 0 }));
    await assert.rejects(client.createCheckout({ ...CHECKOUT_ARGS, uid: '' }));
    assert.equal(calls.length, 0);
  });
});

describe('cancelCheckout', () => {
  it('cancelCheckout chama POST /checkouts/{id}/cancel', async () => {
    const { impl, calls } = fakeFetch({ id: 'abc', status: 'CANCELED' });
    const client = createClient({ baseUrl: BASE, apiKey: KEY, fetchImpl: impl });
    const out = await client.cancelCheckout('abc-123');
    assert.equal(out, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE}/checkouts/abc-123/cancel`);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.access_token, KEY);
  });
});

describe('classifyEvent', () => {
  it('classifyEvent: CHECKOUT_PAID → paid com uid do externalReference', () => {
    assert.deepEqual(classifyEvent(events.checkoutPaidPix), {
      kind: 'paid',
      uid: 'uid-teste-pix-002',
      checkoutId: '97d20bc1-7ede-4f70-9e5c-8e80f6dad160',
      paymentId: null,
      method: null,
      installments: null,
      installmentId: null,
      value: null,
      netValue: null,
      refunded: null,
    });
  });

  it('classifyEvent: pagamento confirmado de Pix → paid', () => {
    assert.deepEqual(classifyEvent(events.pixReceived), {
      kind: 'paid',
      uid: null,
      checkoutId: '97d20bc1-7ede-4f70-9e5c-8e80f6dad160',
      paymentId: 'pay_55jz1por0iil4o4h',
      method: 'PIX',
      installments: null,
      installmentId: null,
      value: 159,
      netValue: 157.01,
      refunded: null,
    });
  });

  it('classifyEvent: cartão parcelado → paid com installments', () => {
    assert.deepEqual(classifyEvent(events.cardConfirmed), {
      kind: 'paid',
      uid: null,
      checkoutId: '121ab2db-988e-4418-9d5d-45a58638ba01',
      paymentId: 'pay_5abeog1boszmcyki',
      method: 'CREDIT_CARD',
      installments: 12,
      installmentId: '1e7dbfdd-d86d-46dc-82a8-ba347835a5c6',
      value: 13.25,
      netValue: 12.69,
      refunded: null,
    });
  });

  it('classifyEvent: cartão à vista (sem parcelamento) → installments 1', () => {
    const body = structuredClone(events.cardConfirmed);
    delete body.payment.installment;
    body.payment.installmentNumber = null;
    body.payment.description = null;
    body.payment.value = 159;
    const out = classifyEvent(body);
    assert.equal(out.kind, 'paid');
    assert.equal(out.installments, 1);
    assert.equal(out.installmentId, null);
  });

  it('classifyEvent: reembolso → refunded', () => {
    const out = classifyEvent(events.cardRefunded);
    assert.equal(out.kind, 'refunded');
    assert.equal(out.checkoutId, '121ab2db-988e-4418-9d5d-45a58638ba01');
    assert.equal(out.paymentId, 'pay_5abeog1boszmcyki');
    assert.equal(out.method, 'CREDIT_CARD');
    assert.equal(out.installmentId, '1e7dbfdd-d86d-46dc-82a8-ba347835a5c6');
  });

  it('classifyEvent: estorno → chargeback', () => {
    const out = classifyEvent(events.cardChargeback);
    assert.equal(out.kind, 'chargeback');
    assert.equal(out.checkoutId, '121ab2db-988e-4418-9d5d-45a58638ba01');
    assert.equal(out.paymentId, 'pay_5abeog1boszmcyki');
    const dispute = structuredClone(events.cardChargeback);
    dispute.event = 'PAYMENT_CHARGEBACK_DISPUTE';
    assert.equal(classifyEvent(dispute).kind, 'chargeback');
  });

  it('classifyEvent: reprovado na análise de risco / captura recusada → rejected', () => {
    for (const event of ['PAYMENT_REPROVED_BY_RISK_ANALYSIS', 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED']) {
      const e = structuredClone(events.cardConfirmed);
      e.event = event;
      const out = classifyEvent(e);
      assert.equal(out.kind, 'rejected');
      assert.equal(out.checkoutId, e.payment.checkoutSession);
    }
    const del = structuredClone(events.cardConfirmed);
    del.event = 'PAYMENT_DELETED';
    assert.equal(classifyEvent(del).kind, 'ignore');
  });

  it('classifyEvent: evento desconhecido → ignore', () => {
    const empty = { kind: 'ignore', uid: null, checkoutId: null, paymentId: null, method: null, installments: null, installmentId: null, value: null, netValue: null, refunded: null };
    assert.deepEqual(classifyEvent(events.pixCreated), empty);
    assert.deepEqual(classifyEvent({ event: 'CHECKOUT_EXPIRED', checkout: { id: 'x', externalReference: 'u' } }), empty);
    assert.deepEqual(classifyEvent({ event: 'ALGO_NOVO' }), empty);
    assert.deepEqual(classifyEvent(null), empty);
    assert.deepEqual(classifyEvent('lixo'), empty);
    assert.deepEqual(classifyEvent({ event: 'PAYMENT_CONFIRMED' }), empty, 'pago sem payment é ignorado');
  });
});

describe('fake-asaas', () => {
  let fake;
  let receiver;
  let received = [];
  let fakeUrl;
  let receiverUrl;

  before(async () => {
    const { startFakeAsaas } = await import('../fake-asaas.mjs');
    fake = await startFakeAsaas({ port: 0 });
    fakeUrl = `http://127.0.0.1:${fake.port}`;
    receiver = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        received.push({ token: req.headers['asaas-access-token'], body: JSON.parse(data) });
        res.end('ok');
      });
    });
    await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
    receiverUrl = `http://127.0.0.1:${receiver.address().port}/asaasWebhook`;
  });

  after(async () => {
    await fake.close();
    await new Promise((r) => receiver.close(r));
  });

  it('cria e cancela checkout pelo cliente real', async () => {
    const client = createClient({ baseUrl: `${fakeUrl}/v3`, apiKey: KEY });
    const co = await client.createCheckout(CHECKOUT_ARGS);
    assert.ok(co.id);
    assert.match(co.url, new RegExp(co.id));
    const list = await (await fetch(`${fakeUrl}/__checkouts`)).json();
    const saved = list.find((c) => c.id === co.id);
    assert.equal(saved.externalReference, 'uid-123');
    assert.equal(saved.status, 'ACTIVE');
    await client.cancelCheckout(co.id);
    const list2 = await (await fetch(`${fakeUrl}/__checkouts`)).json();
    assert.equal(list2.find((c) => c.id === co.id).status, 'CANCELED');
  });

  it('recusa chamada sem access_token', async () => {
    const res = await fetch(`${fakeUrl}/v3/checkouts`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 401);
  });

  it('modo falha faz /checkouts responder 500', async () => {
    const client = createClient({ baseUrl: `${fakeUrl}/v3`, apiKey: KEY });
    await fetch(`${fakeUrl}/__fail`, { method: 'POST', body: JSON.stringify({ checkouts: true }) });
    await assert.rejects(client.createCheckout(CHECKOUT_ARGS), (err) => err.status === 500);
    await fetch(`${fakeUrl}/__fail`, { method: 'POST', body: JSON.stringify({ checkouts: false }) });
    const co = await client.createCheckout(CHECKOUT_ARGS);
    assert.ok(co.id);
  });

  it('POST /__emit repassa o corpo ao alvo com asaas-access-token', async () => {
    received = [];
    const res = await fetch(`${fakeUrl}/__emit`, {
      method: 'POST',
      body: JSON.stringify({ target: receiverUrl, token: 'token-do-webhook', body: events.pixReceived }),
    });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.status, 200);
    assert.equal(received.length, 1);
    assert.equal(received[0].token, 'token-do-webhook');
    assert.deepEqual(received[0].body, events.pixReceived);
  });
});

describe('classifyEvent: reembolso parcial', () => {
  it('soma só os reembolsos concluídos', () => {
    const body = { event: 'PAYMENT_PARTIALLY_REFUNDED', payment: { id: 'pay_1', checkoutSession: 'ck_1', billingType: 'PIX', value: 5, netValue: 3.01,
      refunds: [{ status: 'DONE', value: 1.5 }, { status: 'DONE', value: 1.5 }, { status: 'PENDING', value: 9 }] } };
    const r = classifyEvent(body);
    assert.equal(r.kind, 'partial-refund');
    assert.equal(r.checkoutId, 'ck_1');
    assert.equal(r.refunded, 3);
    assert.equal(classifyEvent({ ...body, payment: { ...body.payment, refunds: undefined } }).refunded, null);
  });
});
