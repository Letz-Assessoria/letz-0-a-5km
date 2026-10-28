// Testes do checkout da medalha (startMedalCheckout) e do mailer no emulador
// (Auth + Firestore + Functions, projeto demo-letz) com o Asaas falso na porta 7777.
// Rode com: npm run test:functions
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { startFakeAsaas } from '../fake-asaas.mjs';

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

const PROJECT = 'demo-letz';
const FN = `http://127.0.0.1:5001/${PROJECT}/southamerica-east1`;
const AUTH = 'http://127.0.0.1:9099';

const events = JSON.parse(readFileSync(new URL('./fixtures/asaas-events.json', import.meta.url), 'utf8'));
// Token do webhook: o mesmo valor falso que o emulador lê de functions/.secret.local.
const WEBHOOK_TOKEN = readFileSync(new URL('../../functions/.secret.local', import.meta.url), 'utf8')
  .split('\n').find((l) => l.startsWith('ASAAS_WEBHOOK_TOKEN=')).slice('ASAAS_WEBHOOK_TOKEN='.length).trim();

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

let fake;
let seq = 0;

async function call(name, data, idToken) {
  const headers = { 'content-type': 'application/json' };
  if (idToken) headers.authorization = 'Bearer ' + idToken;
  const res = await fetch(`${FN}/${name}`, { method: 'POST', headers, body: JSON.stringify({ data }) });
  const body = await res.json();
  if (body.error) return { error: body.error };
  return { result: body.result };
}

async function signIn(email, password) {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const b = await res.json();
  if (!b.idToken) throw new Error('login falhou: ' + JSON.stringify(b));
  return b.idToken;
}

function makeCpf() {
  const base = String(100000000 + Math.floor(Math.random() * 899999999)).slice(0, 9).split('').map(Number);
  for (let n = 9; n < 11; n++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += base[i] * (n + 1 - i);
    base.push((sum * 10) % 11 % 10);
  }
  return base.join('');
}

function person(extra = {}) {
  seq += 1;
  return {
    name: 'Aluna Medalha ' + seq,
    email: `medalha${seq}-${Date.now()}@exemplo.com`,
    password: 'senha-forte-123',
    cpf: makeCpf(),
    phone: '(81) 99999-0000',
    address: { cep: '50050-000', street: 'Rua da Aurora', number: '100', complement: 'Apto 2', district: 'Boa Vista', city: 'Recife', uf: 'PE' },
    acceptPolicy: true,
    ...extra,
  };
}

async function signupOk(p = person()) {
  const r = await call('signup', p);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  const user = await admin.auth().getUserByEmail(p.email);
  return { p, uid: user.uid };
}

const get = async (path) => (await db.doc(path).get()).data();
const sentCheckouts = async () => (await fetch(`${fake.url}/__checkouts`)).json();
// Só os checkouts da medalha (o signup abre um do programa).
const medalCheckouts = async () => (await sentCheckouts()).filter((c) => c.items[0].value === 35);

const KEYS = [];
for (let w = 1; w <= 7; w++) for (let d = 0; d < 3; d++) KEYS.push([w, d]);
KEYS.push([8, 0], [8, 1], [9, 0], [9, 1], [9, 2], [10, 0], [10, 1], [10, 2]);

async function seedPosts(uid, keys = KEYS.slice(0, 24).concat([[10, 0], [10, 1], [10, 2]])) {
  const seen = new Set();
  let i = 0;
  for (const [w, d] of keys) {
    if (seen.has(`${w}-${d}`)) continue;
    seen.add(`${w}-${d}`);
    i += 1;
    await db.doc(`posts/${uid}_${w}-${d}`).set({
      uid, handle: 'x' + uid.slice(0, 5), name: 'N', photoURL: '', w, d,
      at: admin.firestore.Timestamp.fromMillis(Date.now() - 60 * 864e5 + i * 864e5),
      comment: '', photoPath: '', imgURL: '', hidden: false, authorActive: true,
    });
  }
}

// Aluno ativo que concluiu: conta criada pelo signup, access ativado e posts semeados.
async function concluded(extra = {}) {
  const s = await signupOk(person(extra));
  await db.doc('users/' + s.uid).update({ access: 'active' });
  await seedPosts(s.uid);
  s.token = await signIn(s.p.email, s.p.password);
  return s;
}

async function wipe() {
  for (const c of ['users', 'posts', 'cpfs', 'checkouts', 'asaasEvents', 'config', 'rateLimits', 'testFaults', 'alerts', 'payments', 'testMail']) {
    await db.recursiveDelete(db.collection(c));
  }
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  await fetch(`${fake.url}/__reset`, { method: 'POST' });
}

describe('medalha: startMedalCheckout', () => {
  before(async () => {
    fake = await startFakeAsaas({ port: 7777 });
  });
  beforeEach(wipe);
  after(async () => {
    await wipe();
    await fake.close();
  });

  it('aluno concluído com o endereço do cadastro: 1 checkout de R$ 35, 1x, pedido pending', async () => {
    const s = await concluded();
    const r = await call('startMedalCheckout', { useSignupAddress: true }, s.token);
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    assert.match(r.result.checkoutUrl, /^http:\/\/127\.0\.0\.1:7777\/checkoutSession\/show\//);

    const sent = await medalCheckouts();
    assert.equal(sent.length, 1);
    const c = sent[0];
    assert.equal(c.items[0].value, 35);
    assert.equal(c.items[0].name, 'Medalha Letz bora!');
    assert.equal(c.items[0].description, 'Frete da medalha de conclusão');
    assert.deepEqual(c.chargeTypes, ['DETACHED']);
    assert.equal(c.installment, null);
    assert.equal(c.externalReference, s.uid);
    assert.equal(c.callback.successUrl, 'http://localhost:5050/#/medalha');
    assert.equal(c.callback.cancelUrl, 'http://localhost:5050/#/app/fim');
    assert.equal(c.customerData.address, 'Rua da Aurora');
    assert.equal(c.customerData.postalCode, '50050000');

    const m = await get(`users/${s.uid}/private/medal`);
    assert.equal(m.status, 'pending');
    assert.equal(m.url, r.result.checkoutUrl);
    assert.equal(m.refundCount, 0);
    assert.equal(m.address.street, 'Rua da Aurora');
    assert.ok(m.expiresAt.toMillis() > Date.now());
    assert.ok(m.updatedAt);
    const co = await get('checkouts/' + m.checkoutId);
    assert.equal(co.kind, 'medal');
    assert.equal(co.uid, s.uid);
    assert.equal(co.value, 35);
  });

  it('abrir o pedido marca users.medalOrder (a aba Medalhas lista quem tem pedido, mesmo sem concluded)', async () => {
    const s = await concluded();
    assert.equal((await get('users/' + s.uid)).medalOrder, undefined);
    const r = await call('startMedalCheckout', { useSignupAddress: true }, s.token);
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    assert.equal((await get('users/' + s.uid)).medalOrder, true);
  });

  it('endereço novo (useSignupAddress false) vai para o checkout e para medal.address', async () => {
    const s = await concluded();
    const address = { cep: '01310-100', street: 'Avenida Paulista', number: '1000', complement: '', district: 'Bela Vista', city: 'São Paulo', uf: 'sp' };
    const r = await call('startMedalCheckout', { useSignupAddress: false, address }, s.token);
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    const c = (await medalCheckouts())[0];
    assert.equal(c.customerData.address, 'Avenida Paulista');
    assert.equal(c.customerData.city, 'São Paulo');
    const m = await get(`users/${s.uid}/private/medal`);
    assert.equal(m.address.street, 'Avenida Paulista');
    assert.equal(m.address.cep, '01310100');
    assert.equal(m.address.uf, 'SP');
  });

  it('recusa quem não concluiu, quem não está ativo e anônimo, sem criar checkout', async () => {
    const half = await signupOk(person());
    await db.doc('users/' + half.uid).update({ access: 'active' });
    await seedPosts(half.uid, KEYS.slice(0, 20));
    const halfToken = await signIn(half.p.email, half.p.password);
    // 24 treinos, mas sem o 10-2
    const no102 = await signupOk(person());
    await db.doc('users/' + no102.uid).update({ access: 'active' });
    await seedPosts(no102.uid, KEYS.filter(([w, d]) => !(w === 10 && d === 2)));
    const no102Token = await signIn(no102.p.email, no102.p.password);
    const pend = await signupOk(person());
    await seedPosts(pend.uid);
    const pendToken = await signIn(pend.p.email, pend.p.password);

    for (const token of [halfToken, no102Token, pendToken]) {
      const r = await call('startMedalCheckout', { useSignupAddress: true }, token);
      assert.equal(r.error && r.error.status, 'FAILED_PRECONDITION', JSON.stringify(r));
    }
    const anon = await call('startMedalCheckout', { useSignupAddress: true });
    assert.equal(anon.error && anon.error.status, 'UNAUTHENTICATED');
    assert.equal((await medalCheckouts()).length, 0);
  });

  it('conclusão vem dos posts: concluded:true forjado sem posts é recusado', async () => {
    const s = await signupOk(person());
    await db.doc('users/' + s.uid).update({ access: 'active', concluded: true });
    const token = await signIn(s.p.email, s.p.password);
    const r = await call('startMedalCheckout', { useSignupAddress: true }, token);
    assert.equal(r.error && r.error.status, 'FAILED_PRECONDITION');
    assert.equal((await medalCheckouts()).length, 0);
  });

  it('pedido já paid ou shipped: failed-precondition', async () => {
    for (const status of ['paid', 'shipped', 'delivered']) {
      const s = await concluded();
      await db.doc(`users/${s.uid}/private/medal`).set({ status, refundCount: 0 });
      const r = await call('startMedalCheckout', { useSignupAddress: true }, s.token);
      assert.equal(r.error && r.error.status, 'FAILED_PRECONDITION', status);
    }
    assert.equal((await medalCheckouts()).length, 0);
  });

  it('segunda chamada com checkout pending válido devolve a mesma URL, sem novo checkout', async () => {
    const s = await concluded();
    const a = await call('startMedalCheckout', { useSignupAddress: true }, s.token);
    const b = await call('startMedalCheckout', { useSignupAddress: true }, s.token);
    assert.equal(b.error, undefined, JSON.stringify(b.error));
    assert.equal(b.result.checkoutUrl, a.result.checkoutUrl);
    assert.equal((await medalCheckouts()).length, 1);
  });

  it('pending com endereço diferente: abre outro checkout e cancela o anterior', async () => {
    const s = await concluded();
    const a = await call('startMedalCheckout', { useSignupAddress: true }, s.token);
    const address = { cep: '01310-100', street: 'Avenida Paulista', number: '1000', complement: '', district: 'Bela Vista', city: 'São Paulo', uf: 'SP' };
    const b = await call('startMedalCheckout', { useSignupAddress: false, address }, s.token);
    assert.equal(b.error, undefined, JSON.stringify(b.error));
    assert.notEqual(b.result.checkoutUrl, a.result.checkoutUrl);
    const m = await get(`users/${s.uid}/private/medal`);
    assert.equal(m.url, b.result.checkoutUrl);
    const sent = await medalCheckouts();
    assert.deepEqual(sent.map((c) => c.status).sort(), ['ACTIVE', 'CANCELED']);
  });

  it('refundCount >= 2 é recusado; refunded com refundCount 1 pode comprar de novo', async () => {
    const s = await concluded();
    await db.doc(`users/${s.uid}/private/medal`).set({ status: 'refunded', refundCount: 2 });
    const no = await call('startMedalCheckout', { useSignupAddress: true }, s.token);
    assert.equal(no.error && no.error.status, 'FAILED_PRECONDITION');
    assert.equal((await medalCheckouts()).length, 0);

    await db.doc(`users/${s.uid}/private/medal`).set({ status: 'refunded', refundCount: 1 });
    const ok = await call('startMedalCheckout', { useSignupAddress: true }, s.token);
    assert.equal(ok.error, undefined, JSON.stringify(ok.error));
    const m = await get(`users/${s.uid}/private/medal`);
    assert.equal(m.status, 'pending');
    assert.equal(m.refundCount, 1);
  });

  it('recompra depois de refunded: apaga o que era do pedido anterior e preserva refundCount; novo pedido pago pode pedir reembolso', async () => {
    const s = await concluded();
    const ts = admin.firestore.Timestamp.fromMillis(Date.now() - 864e5);
    await db.doc(`users/${s.uid}/private/medal`).set({
      status: 'refunded', refundCount: 1, checkoutId: 'ck-velho', paidAt: ts, refundRequestedAt: admin.firestore.Timestamp.now(),
      emailedAt: ts, emailedCount: 2, trackingCode: 'BR123456789BR', shippedAt: '2026-10-20', deliveredAt: '2026-10-25',
    });
    const r = await call('startMedalCheckout', { useSignupAddress: true }, s.token);
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    const m = await get(`users/${s.uid}/private/medal`);
    assert.equal(m.status, 'pending');
    assert.equal(m.refundCount, 1);
    for (const k of ['refundRequestedAt', 'emailedAt', 'emailedCount', 'paidAt', 'trackingCode', 'shippedAt', 'deliveredAt']) {
      assert.equal(m[k], undefined, k);
    }
    // Segundo pedido pago: o aluno consegue pedir o reembolso dele (e o e-mail de envio sai de novo).
    assert.equal((await hook(payment('pixReceived', m.checkoutId))).status, 200);
    assert.deepEqual((await call('requestRefund', { product: 'medal' }, s.token)).result, { ok: true });
    assert.ok((await get(`users/${s.uid}/private/medal`)).refundRequestedAt);
  });

  it('conta sem private/profile: com endereço informado abre o checkout sem customerData; useSignupAddress dá invalid-argument', async () => {
    const s = await concluded();
    await db.doc(`users/${s.uid}/private/profile`).delete();
    const address = { cep: '01310-100', street: 'Avenida Paulista', number: '1000', complement: '', district: 'Bela Vista', city: 'São Paulo', uf: 'SP' };
    const ok = await call('startMedalCheckout', { useSignupAddress: false, address }, s.token);
    assert.equal(ok.error, undefined, JSON.stringify(ok.error));
    const c = (await medalCheckouts())[0];
    assert.equal(c.customerData, null);
    assert.equal((await get(`users/${s.uid}/private/medal`)).address.street, 'Avenida Paulista');
    await db.doc(`users/${s.uid}/private/medal`).delete();
    const no = await call('startMedalCheckout', { useSignupAddress: true }, s.token);
    assert.equal(no.error && no.error.status, 'INVALID_ARGUMENT');
  });

  it('endereço inválido: invalid-argument; cadastro sem endereço com useSignupAddress também', async () => {
    const s = await concluded();
    const bad = await call('startMedalCheckout', { useSignupAddress: false, address: { cep: '123', street: '' } }, s.token);
    assert.equal(bad.error && bad.error.status, 'INVALID_ARGUMENT');
    const none = await call('startMedalCheckout', { useSignupAddress: false }, s.token);
    assert.equal(none.error && none.error.status, 'INVALID_ARGUMENT');
    await db.doc(`users/${s.uid}/private/profile`).update({ address: admin.firestore.FieldValue.delete() });
    const old = await call('startMedalCheckout', { useSignupAddress: true }, s.token);
    assert.equal(old.error && old.error.status, 'INVALID_ARGUMENT');
    assert.equal((await medalCheckouts()).length, 0);
  });

  it('Asaas fora do ar: unavailable e nenhum pedido gravado', async () => {
    const s = await concluded();
    await fetch(`${fake.url}/__fail`, { method: 'POST', body: JSON.stringify({ checkouts: true }) });
    const r = await call('startMedalCheckout', { useSignupAddress: true }, s.token);
    assert.equal(r.error && r.error.status, 'UNAVAILABLE');
    assert.equal((await db.doc(`users/${s.uid}/private/medal`).get()).exists, false);
  });
});


function hook(body) {
  return fetch(`${FN}/asaasWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'asaas-access-token': WEBHOOK_TOKEN },
    body: JSON.stringify(body),
  });
}

function checkoutPaid(uid, checkoutId, id = 'evt_checkout_' + Math.random()) {
  const e = structuredClone(events.checkoutPaidPix);
  e.id = id;
  e.checkout.id = checkoutId;
  e.checkout.externalReference = uid;
  return e;
}

function payment(fixture, checkoutId, { id, paymentId, event, value, netValue } = {}) {
  const e = structuredClone(events[fixture]);
  e.id = id || 'evt_' + fixture + '_' + Math.random();
  if (event) e.event = event;
  e.payment.checkoutSession = checkoutId;
  if (paymentId) e.payment.id = paymentId;
  if (value !== undefined) e.payment.value = value;
  if (netValue !== undefined) e.payment.netValue = netValue;
  return e;
}

const alertTypes = async () => (await db.collection('alerts').get()).docs.map((d) => d.data().type);

// Aluno que concluiu, com o pedido da medalha aberto (pending) e o checkout dela gravado.
async function withOrder() {
  const s = await concluded();
  const r = await call('startMedalCheckout', { useSignupAddress: true }, s.token);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  const m = await get(`users/${s.uid}/private/medal`);
  s.checkoutId = m.checkoutId;
  return s;
}

describe('medalha: envio (updateMedalOrder, resendMedalEmail)', () => {
  before(async () => {
    fake = await startFakeAsaas({ port: 7777 });
  });
  beforeEach(wipe);
  after(async () => {
    await wipe();
    await fake.close();
  });

  const adminToken = async () => {
    seq += 1;
    const email = `treinador${seq}-${Date.now()}@exemplo.com`;
    const u = await admin.auth().createUser({ email, password: 'senha-forte-123' });
    await admin.auth().setCustomUserClaims(u.uid, { admin: true });
    return signIn(email, 'senha-forte-123');
  };
  const orderOf = (uid) => get(`users/${uid}/private/medal`);
  const mailN = async () => ((await db.doc('testMail/last').get()).get('n')) || 0;
  const lastMail = async () => (await db.doc('testMail/last').get()).data();
  // Aluno com pedido da medalha no status dado (semeado direto).
  const withStatus = async (status, extra = {}) => {
    const s = await withOrder();
    await db.doc(`users/${s.uid}/private/medal`).update({ status, ...extra });
    s.tr = await adminToken();
    return s;
  };
  const upd = (s, data) => call('updateMedalOrder', { uid: s.uid, ...data }, s.tr);

  it('só admin: aluno e anônimo recebem permission-denied/unauthenticated, nada muda', async () => {
    const s = await withStatus('paid');
    for (const fn of ['updateMedalOrder', 'resendMedalEmail']) {
      const a = await call(fn, { uid: s.uid, status: 'shipped', trackingCode: 'AB123' }, s.token);
      assert.equal(a.error.status, 'PERMISSION_DENIED');
      const n = await call(fn, { uid: s.uid, status: 'shipped', trackingCode: 'AB123' });
      assert.equal(n.error.status, 'UNAUTHENTICATED');
    }
    assert.equal((await orderOf(s.uid)).status, 'paid');
    assert.equal(await mailN(), 0);
  });

  it('paid→shipped sem rastreio ou com rastreio/data inválidos: invalid-argument, nada muda', async () => {
    const s = await withStatus('paid');
    for (const extra of [{}, { trackingCode: 'ab' }, { trackingCode: 'AB 123' }, { trackingCode: 'A'.repeat(41) }, { trackingCode: 'AB123', shippedAt: '31/10/2026' }, { trackingCode: 'AB123', shippedAt: '2026-02-31' }]) {
      assert.equal((await upd(s, { status: 'shipped', ...extra })).error.status, 'INVALID_ARGUMENT', JSON.stringify(extra));
    }
    assert.equal((await upd(s, { status: 'enviado' })).error.status, 'INVALID_ARGUMENT');
    assert.equal((await orderOf(s.uid)).status, 'paid');
    assert.equal(await mailN(), 0);
  });

  it('paid→shipped: grava rastreio e data, envia 1 e-mail com nome, rastreio, data e endereço, sem pagamento', async () => {
    const s = await withStatus('paid');
    const r = await upd(s, { status: 'shipped', trackingCode: 'BR123456789', shippedAt: '2026-11-03' });
    assert.deepEqual(r.result, { ok: true, emailed: true });
    const o = await orderOf(s.uid);
    assert.equal(o.status, 'shipped');
    assert.equal(o.trackingCode, 'BR123456789');
    assert.equal(o.shippedAt, '2026-11-03');
    assert.equal(o.emailedCount, 1);
    assert.ok(o.emailedAt);
    assert.equal(await mailN(), 1);
    const m = await lastMail();
    assert.equal(m.from, 'Letz Assessoria <letzassessoria@gmail.com>');
    assert.equal(m.to, s.p.email);
    assert.match(m.subject, /medalha/i);
    const first = s.p.name.split(' ')[0];
    for (const part of [first, 'BR123456789', '03/11/2026', 'Rua da Aurora, 100', 'Recife/PE', 'CEP 50050-000']) assert.ok(m.text.includes(part), part);
    assert.doesNotMatch(m.text, /R\$|35|pix|cart[aã]o|cpf|checkout/i);
  });

  it('sem shippedAt usa hoje; editar o rastreio de shipped não reenvia e-mail', async () => {
    const s = await withStatus('paid');
    await upd(s, { status: 'shipped', trackingCode: 'AAA111' });
    assert.match((await orderOf(s.uid)).shippedAt, /^\d{4}-\d{2}-\d{2}$/);
    const r = await upd(s, { status: 'shipped', trackingCode: 'BBB222' });
    assert.deepEqual(r.result, { ok: true, emailed: false });
    assert.equal((await orderOf(s.uid)).trackingCode, 'BBB222');
    assert.equal(await mailN(), 1);
  });

  it('shipped→delivered grava a data; delivered→shipped e shipped→paid voltam sem e-mail e sem reenvio ao reenviar', async () => {
    const s = await withStatus('paid');
    await upd(s, { status: 'shipped', trackingCode: 'AAA111', shippedAt: '2026-11-03' });
    assert.deepEqual((await upd(s, { status: 'delivered', deliveredAt: '2026-11-09' })).result, { ok: true, emailed: false });
    let o = await orderOf(s.uid);
    assert.deepEqual([o.status, o.deliveredAt, o.trackingCode], ['delivered', '2026-11-09', 'AAA111']);
    assert.equal((await upd(s, { status: 'shipped' })).result.emailed, false);
    o = await orderOf(s.uid);
    assert.deepEqual([o.status, o.deliveredAt, o.trackingCode], ['shipped', undefined, 'AAA111']);
    assert.equal((await upd(s, { status: 'paid' })).result.emailed, false);
    o = await orderOf(s.uid);
    assert.deepEqual([o.status, o.trackingCode, o.shippedAt], ['paid', undefined, undefined]);
    // Segunda passagem para shipped: o e-mail já saiu uma vez, não repete.
    assert.equal((await upd(s, { status: 'shipped', trackingCode: 'CCC333' })).result.emailed, false);
    assert.equal(await mailN(), 1);
  });

  it('transições inválidas: failed-precondition', async () => {
    for (const [from, to] of [['pending', 'shipped'], ['pending', 'paid'], ['refunded', 'delivered'], ['refunded', 'shipped'], ['paid', 'delivered'], ['delivered', 'paid'], ['paid', 'paid']]) {
      const s = await withStatus(from, { trackingCode: 'AAA111', shippedAt: '2026-11-03' });
      const r = await upd(s, { status: to, trackingCode: 'AAA111' });
      assert.equal(r.error && r.error.status, 'FAILED_PRECONDITION', `${from}→${to}`);
      assert.equal((await orderOf(s.uid)).status, from);
    }
    const s = await withStatus('paid');
    await db.doc(`users/${s.uid}/private/medal`).delete();
    assert.equal((await upd(s, { status: 'shipped', trackingCode: 'AAA111' })).error.status, 'FAILED_PRECONDITION');
    assert.equal(await mailN(), 0);
  });

  it('falha do e-mail: o status muda mesmo assim, emailed:false e alerta medal-email-failed', async () => {
    const s = await withStatus('paid');
    await db.doc('testFaults/mail').set({ fail: true });
    const r = await upd(s, { status: 'shipped', trackingCode: 'AAA111' });
    assert.deepEqual(r.result, { ok: true, emailed: false });
    const o = await orderOf(s.uid);
    assert.equal(o.status, 'shipped');
    assert.equal(o.emailedAt, undefined);
    assert.equal(await mailN(), 0);
    const alerts = (await db.collection('alerts').get()).docs.map((d) => d.data());
    assert.deepEqual(alerts.map((a) => [a.type, a.uid, a.resolved]), [['medal-email-failed', s.uid, false]]);
    // Reenviar depois que o problema passou: sai e registra.
    await db.doc('testFaults/mail').delete();
    assert.deepEqual((await call('resendMedalEmail', { uid: s.uid }, s.tr)).result, { ok: true, emailed: true });
    assert.equal((await orderOf(s.uid)).emailedCount, 1);
  });

  it('resendMedalEmail: só shipped/delivered; reenvia e conta', async () => {
    for (const st of ['pending', 'paid', 'refunded']) {
      const s = await withStatus(st);
      assert.equal((await call('resendMedalEmail', { uid: s.uid }, s.tr)).error.status, 'FAILED_PRECONDITION', st);
    }
    const s = await withStatus('paid');
    await upd(s, { status: 'shipped', trackingCode: 'AAA111', shippedAt: '2026-11-03' });
    assert.deepEqual((await call('resendMedalEmail', { uid: s.uid }, s.tr)).result, { ok: true, emailed: true });
    assert.equal((await orderOf(s.uid)).emailedCount, 2);
    assert.equal(await mailN(), 2);
    await upd(s, { status: 'delivered' });
    assert.equal((await call('resendMedalEmail', { uid: s.uid }, s.tr)).result.emailed, true);
    assert.equal((await call('resendMedalEmail', {}, s.tr)).error.status, 'INVALID_ARGUMENT');
  });
});

describe('reembolso e recompra', () => {
  before(async () => {
    fake = await startFakeAsaas({ port: 7777 });
  });
  beforeEach(wipe);
  after(async () => {
    await wipe();
    await fake.close();
  });

  const daysAgo = (n) => admin.firestore.Timestamp.fromMillis(Date.now() - n * 864e5);
  // Conta com o programa pago há `days` dias (billing e acesso semeados direto).
  async function paidProgram(days, extra = {}) {
    const s = await signupOk(person());
    await db.doc('users/' + s.uid).update({ access: 'active' });
    await db.doc(`users/${s.uid}/private/billing`).update({ status: 'paid', paidAt: daysAgo(days), ...extra });
    s.token = await signIn(s.p.email, s.p.password);
    return s;
  }
  const billingOf = (uid) => get(`users/${uid}/private/billing`);

  describe('requestRefund', () => {
    it('programa pago há 3 dias: ok e grava refundRequestedAt; repetir no mesmo dia não regrava', async () => {
      const s = await paidProgram(3);
      const r = await call('requestRefund', { product: 'program' }, s.token);
      assert.deepEqual(r.result, { ok: true });
      const first = (await billingOf(s.uid)).refundRequestedAt;
      assert.ok(first);
      assert.deepEqual((await call('requestRefund', { product: 'program' }, s.token)).result, { ok: true });
      assert.equal((await billingOf(s.uid)).refundRequestedAt.toMillis(), first.toMillis());
    });

    it('pedido de um dia anterior é renovado', async () => {
      const s = await paidProgram(3, { refundRequestedAt: daysAgo(1) });
      assert.deepEqual((await call('requestRefund', { product: 'program' }, s.token)).result, { ok: true });
      assert.ok((await billingOf(s.uid)).refundRequestedAt.toMillis() > Date.now() - 60000);
    });

    it('programa pago há 8 dias: failed-precondition e nada gravado', async () => {
      const s = await paidProgram(8);
      const r = await call('requestRefund', { product: 'program' }, s.token);
      assert.equal(r.error.status, 'FAILED_PRECONDITION');
      assert.equal((await billingOf(s.uid)).refundRequestedAt, undefined);
    });

    it('sem pagamento, sem login ou produto inválido: recusado', async () => {
      const s = await signupOk(person());
      const token = await signIn(s.p.email, s.p.password);
      assert.equal((await call('requestRefund', { product: 'program' }, token)).error.status, 'FAILED_PRECONDITION');
      assert.equal((await call('requestRefund', { product: 'medal' }, token)).error.status, 'FAILED_PRECONDITION');
      assert.equal((await call('requestRefund', { product: 'x' }, token)).error.status, 'INVALID_ARGUMENT');
      assert.equal((await call('requestRefund', { product: 'program' })).error.status, 'UNAUTHENTICATED');
    });

    it('medalha paid: ok e grava no pedido; shipped, delivered e pending: recusado', async () => {
      const s = await concluded();
      const ref = db.doc(`users/${s.uid}/private/medal`);
      await ref.set({ status: 'paid', refundCount: 0 });
      assert.deepEqual((await call('requestRefund', { product: 'medal' }, s.token)).result, { ok: true });
      assert.ok((await ref.get()).get('refundRequestedAt'));
      for (const status of ['shipped', 'delivered', 'pending']) {
        await ref.update({ status, refundRequestedAt: admin.firestore.FieldValue.delete() });
        const r = await call('requestRefund', { product: 'medal' }, s.token);
        assert.equal(r.error.status, 'FAILED_PRECONDITION', status);
        assert.equal((await ref.get()).get('refundRequestedAt'), undefined);
      }
    });
  });

  describe('rebuyProgram', () => {
    // Paga pelo webhook e estorna: conta bloqueada com refundCount 1.
    async function refunded() {
      const p = person();
      assert.equal((await call('signup', p)).error, undefined);
      const uid = (await admin.auth().getUserByEmail(p.email)).uid;
      const checkoutId = (await billingOf(uid)).checkoutId;
      await hook(checkoutPaid(uid, checkoutId));
      await hook(payment('cardRefunded', checkoutId));
      return { p, uid, oldCheckout: checkoutId, token: await signIn(p.email, p.password) };
    }

    it('após reembolso (refundCount 1): checkout novo, billing pending, acesso segue blocked até o webhook', async () => {
      const s = await refunded();
      assert.equal((await get('users/' + s.uid)).access, 'blocked');
      const r = await call('rebuyProgram', {}, s.token);
      assert.equal(r.error, undefined, JSON.stringify(r.error));
      assert.match(r.result.checkoutUrl, /^http:\/\/127\.0\.0\.1:7777\/checkoutSession\/show\//);
      const b = await billingOf(s.uid);
      assert.equal(b.status, 'pending');
      assert.equal(b.refundCount, 1);
      assert.notEqual(b.checkoutId, s.oldCheckout);
      assert.equal(b.url, r.result.checkoutUrl);
      assert.equal((await get('users/' + s.uid)).access, 'blocked');
      assert.equal((await get('checkouts/' + b.checkoutId)).status, 'active');
      // pago o novo checkout, o acesso volta
      await hook(checkoutPaid(s.uid, b.checkoutId));
      assert.equal((await get('users/' + s.uid)).access, 'active');
      assert.equal((await billingOf(s.uid)).status, 'paid');
    });

    it('conta reembolsada que o treinador liberou (access active) não recompra', async () => {
      const s = await refunded();
      await db.doc('users/' + s.uid).update({ access: 'active' });
      const r = await call('rebuyProgram', {}, s.token);
      assert.equal(r.error && r.error.status, 'FAILED_PRECONDITION');
      assert.equal((await billingOf(s.uid)).status, 'refunded');
    });

    it('repetir enquanto o checkout vale devolve o mesmo, sem abrir outro', async () => {
      const s = await refunded();
      const a = await call('rebuyProgram', {}, s.token);
      const n = (await sentCheckouts()).length;
      const b = await call('rebuyProgram', {}, s.token);
      assert.equal(b.result.checkoutUrl, a.result.checkoutUrl);
      assert.equal((await sentCheckouts()).length, n);
    });

    it('conta com cupom recompra pelo preço cheio, sem cupom', async () => {
      const s = await refunded();
      await db.doc(`users/${s.uid}/private/billing`).update({ coupon: 'AMIGO10', percent: 10, value: 89.1 });
      assert.equal((await call('rebuyProgram', {}, s.token)).error, undefined);
      const b = await billingOf(s.uid);
      assert.equal(b.coupon, undefined);
      assert.equal(b.value, undefined);
      const sent = await sentCheckouts();
      assert.equal(sent[sent.length - 1].items[0].value, 159);
    });

    it('vendas fechadas: recusa e nenhum checkout; reabertas, recompra normal', async () => {
      const s = await refunded();
      await db.doc('config/app').set({ salesOpen: false });
      const n = (await sentCheckouts()).length;
      const r = await call('rebuyProgram', {}, s.token);
      assert.equal(r.error.status, 'FAILED_PRECONDITION');
      assert.match(r.error.message, /vendas desta turma estão fechadas/);
      assert.equal((await sentCheckouts()).length, n);
      assert.equal((await billingOf(s.uid)).status, 'refunded');
      await db.doc('config/app').set({ salesOpen: true });
      assert.equal((await call('rebuyProgram', {}, s.token)).error, undefined);
      assert.equal((await sentCheckouts()).length, n + 1);
    });

    it('refundCount 2: recusado e nenhum checkout novo', async () => {
      const s = await refunded();
      await db.doc(`users/${s.uid}/private/billing`).update({ refundCount: 2 });
      const n = (await sentCheckouts()).length;
      const r = await call('rebuyProgram', {}, s.token);
      assert.equal(r.error.status, 'FAILED_PRECONDITION');
      assert.equal((await sentCheckouts()).length, n);
      assert.equal((await billingOf(s.uid)).status, 'refunded');
    });

    it('conta nunca reembolsada (pending ou paga): recusado, sem checkout', async () => {
      const pend = await signupOk(person());
      const pendToken = await signIn(pend.p.email, pend.p.password);
      const paid = await paidProgram(2);
      const n = (await sentCheckouts()).length;
      assert.equal((await call('rebuyProgram', {}, pendToken)).error.status, 'FAILED_PRECONDITION');
      assert.equal((await call('rebuyProgram', {}, paid.token)).error.status, 'FAILED_PRECONDITION');
      assert.equal((await call('rebuyProgram', {})).error.status, 'UNAUTHENTICATED');
      assert.equal((await sentCheckouts()).length, n);
      assert.equal((await billingOf(paid.uid)).status, 'paid');
    });

    it('rejected e chargeback também recompram; Asaas fora do ar mantém a conta fechada', async () => {
      for (const status of ['chargeback', 'rejected']) {
        const s = await refunded();
        await db.doc(`users/${s.uid}/private/billing`).update({ status });
        assert.equal((await call('rebuyProgram', {}, s.token)).error, undefined, status);
      }
      const s = await refunded();
      await fetch(`${fake.url}/__fail`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checkouts: true }) });
      const r = await call('rebuyProgram', {}, s.token);
      assert.equal(r.error.status, 'UNAVAILABLE');
      assert.equal((await billingOf(s.uid)).status, 'refunded');
      assert.equal((await get('users/' + s.uid)).access, 'blocked');
    });
  });
});

describe('mailer', () => {
  const mailer = () => require('./src/mailer.js');
  const withEnv = async (value, fn) => {
    const old = process.env.FUNCTIONS_EMULATOR;
    if (value === undefined) delete process.env.FUNCTIONS_EMULATOR; else process.env.FUNCTIONS_EMULATOR = value;
    try {
      return await fn();
    } finally {
      if (old === undefined) delete process.env.FUNCTIONS_EMULATOR; else process.env.FUNCTIONS_EMULATOR = old;
    }
  };

  it('no emulador, sem GMAIL_APP_PASSWORD, usa o transporte falso e guarda a última mensagem', async () => {
    const r = await withEnv('true', () => mailer().sendMail({ to: 'a@b.com', subject: 'Oi', text: 'Texto' }));
    assert.deepEqual(r, { sent: true, fake: true });
    assert.equal(mailer().__lastFake().to, 'a@b.com');
    assert.equal(mailer().__lastFake().subject, 'Oi');
  });

  it('produção (fora do emulador) sem GMAIL_APP_PASSWORD: sent:false not-configured, sem transporte falso', async () => {
    const before = mailer().__lastFake();
    const r = await withEnv(undefined, () => mailer().sendMail({ to: 'c@d.com', subject: 'Prod', text: 'Texto' }));
    assert.deepEqual(r, { sent: false, reason: 'not-configured' });
    assert.equal(mailer().__lastFake(), before);
  });

  it('nunca lança: dados faltando devolve sent:false', async () => {
    assert.equal((await mailer().sendMail({ to: 'a@b.com' })).sent, false);
  });
});

describe('medalha: webhook', () => {
  before(async () => {
    fake = await startFakeAsaas({ port: 7777 });
  });
  beforeEach(wipe);
  after(async () => {
    await wipe();
    await fake.close();
    await admin.app().delete();
  });

  const programState = async (uid) => ({
    access: (await get('users/' + uid)).access,
    billing: (await get(`users/${uid}/private/billing`)),
  });

  it('(a) pago: medal paid, access intacto, linha financeira da medalha, evento repetido não duplica', async () => {
    const s = await withOrder();
    const before = await programState(s.uid);
    const e = payment('pixReceived', s.checkoutId, { value: 35, netValue: 34.01 });
    assert.equal((await hook(e)).status, 200);
    assert.equal((await hook(e)).status, 200);
    assert.equal((await hook(checkoutPaid(s.uid, s.checkoutId))).status, 200);
    const m = await get(`users/${s.uid}/private/medal`);
    assert.equal(m.status, 'paid');
    assert.ok(m.paidAt);
    assert.equal(m.checkoutId, s.checkoutId);
    assert.deepEqual(await programState(s.uid), before);
    assert.equal((await get('checkouts/' + s.checkoutId)).status, 'paid');
    const rows = await db.collection('payments').get();
    assert.equal(rows.size, 1);
    const row = rows.docs[0].data();
    assert.equal(rows.docs[0].id, s.checkoutId);
    assert.equal(row.product, 'Medalha Letz bora!');
    assert.equal(row.kind, 'medal');
    assert.equal(row.status, 'paid');
    assert.equal(row.gross, 35);
    assert.equal(row.net, 34.01);
    assert.equal((await alertTypes()).length, 0);
  });

  it('(b) pagamento de outro checkout de quem já pagou: alerta medal-duplicate uma vez, status segue', async () => {
    const s = await withOrder();
    await hook(payment('pixReceived', s.checkoutId));
    const billingBefore = await get(`users/${s.uid}/private/billing`);
    const userBefore = await get('users/' + s.uid);
    const other = 'checkout-medalha-duplicado';
    await db.doc('checkouts/' + other).set({ kind: 'medal', uid: s.uid, value: 35, status: 'active', createdAt: new Date(), expiresAt: new Date() });
    assert.equal((await hook(payment('pixReceived', other, { paymentId: 'pay_dup_1' }))).status, 200);
    assert.equal((await hook(checkoutPaid(s.uid, other))).status, 200);
    const m = await get(`users/${s.uid}/private/medal`);
    assert.equal(m.status, 'paid');
    assert.equal(m.checkoutId, s.checkoutId);
    assert.deepEqual(await alertTypes(), ['medal-duplicate']);
    assert.equal((await get('checkouts/' + other)).status, 'paid');
    assert.deepEqual(await get(`users/${s.uid}/private/billing`), billingBefore);
    assert.deepEqual(await get('users/' + s.uid), userBefore);
  });

  it('(c) reembolso total com paid: refunded, refundCount 1, sem alerta; chargeback repetido não conta de novo', async () => {
    const s = await withOrder();
    await hook(payment('pixReceived', s.checkoutId));
    assert.equal((await hook(payment('cardRefunded', s.checkoutId))).status, 200);
    assert.equal((await get('payments/' + s.checkoutId)).status, 'refunded');
    assert.equal((await hook(payment('cardChargeback', s.checkoutId))).status, 200);
    const m = await get(`users/${s.uid}/private/medal`);
    assert.equal(m.status, 'refunded');
    assert.equal(m.refundCount, 1);
    assert.equal((await alertTypes()).length, 0);
    assert.equal((await get('checkouts/' + s.checkoutId)).status, 'refunded');
    assert.equal((await get('users/' + s.uid)).access, 'active');
    // pago tardio do checkout reembolsado: alerta e nada de reativar o pedido
    await hook(payment('pixReceived', s.checkoutId, { paymentId: 'pay_tardio_1' }));
    assert.equal((await get(`users/${s.uid}/private/medal`)).status, 'refunded');
    assert.deepEqual(await alertTypes(), ['paid-closed-checkout']);
  });

  it('(c2) chargeback ou reprovação de medalha paid: refunded e alerta medal-chargeback; reembolso do treinador segue sem alerta', async () => {
    const a = await withOrder();
    await hook(payment('pixReceived', a.checkoutId));
    assert.equal((await hook(payment('cardChargeback', a.checkoutId))).status, 200);
    assert.equal((await get(`users/${a.uid}/private/medal`)).status, 'refunded');
    assert.equal((await get(`users/${a.uid}/private/medal`)).refundCount, 1);
    assert.deepEqual(await alertTypes(), ['medal-chargeback']);
  });

  for (const status of ['shipped', 'delivered']) {
    it(`(d) reembolso com ${status}: status, rastreio e datas iguais, refundCount +1, alerta medal-refunded-shipped`, async () => {
      const s = await withOrder();
      await hook(payment('pixReceived', s.checkoutId));
      const ts = admin.firestore.Timestamp.fromMillis(Date.now() - 864e5);
      await db.doc(`users/${s.uid}/private/medal`).update({
        status, trackingCode: 'BR123456789BR', shippedAt: ts, deliveredAt: status === 'delivered' ? ts : null,
      });
      const before = await get(`users/${s.uid}/private/medal`);
      assert.equal((await hook(payment('cardRefunded', s.checkoutId))).status, 200);
      // Chargeback do mesmo checkout (outro id de evento) não conta de novo nem gera 2º alerta.
      assert.equal((await hook(payment('cardChargeback', s.checkoutId))).status, 200);
      const m = await get(`users/${s.uid}/private/medal`);
      assert.equal(m.status, status);
      assert.equal(m.trackingCode, 'BR123456789BR');
      assert.deepEqual(m.shippedAt, before.shippedAt);
      assert.deepEqual(m.deliveredAt, before.deliveredAt);
      assert.equal(m.refundCount, 1);
      assert.deepEqual(await alertTypes(), ['medal-refunded-shipped']);
    });
  }

  it('(d) rejected de checkout da medalha que não é o atual: não conta e não altera nada', async () => {
    const s = await withOrder();
    await hook(payment('pixReceived', s.checkoutId));
    const other = 'checkout-medalha-outro';
    await db.doc('checkouts/' + other).set({ kind: 'medal', uid: s.uid, value: 35, status: 'active', createdAt: new Date(), expiresAt: new Date() });
    const before = await get(`users/${s.uid}/private/medal`);
    const e = payment('cardRefunded', other, { event: 'PAYMENT_REPROVED_BY_RISK_ANALYSIS', paymentId: 'pay_rj_outro' });
    assert.equal((await hook(e)).status, 200);
    assert.deepEqual(await get(`users/${s.uid}/private/medal`), before);
    assert.equal((await get('checkouts/' + other)).status, 'active');
    assert.equal((await get('checkouts/' + s.checkoutId)).status, 'paid');
    assert.equal((await alertTypes()).length, 0);
  });

  it('(e) reembolso parcial: só o alerta medal-partial-refund', async () => {
    const s = await withOrder();
    await hook(payment('pixReceived', s.checkoutId));
    const before = await get(`users/${s.uid}/private/medal`);
    const e = payment('pixReceived', s.checkoutId, { event: 'PAYMENT_PARTIALLY_REFUNDED', paymentId: 'pay_parcial_m' });
    e.payment.refunds = [{ status: 'DONE', value: 5 }];
    assert.equal((await hook(e)).status, 200);
    assert.equal((await hook(e)).status, 200);
    const list = (await db.collection('alerts').get()).docs.map((d) => d.data());
    assert.equal(list.length, 1);
    assert.equal(list[0].type, 'medal-partial-refund');
    assert.equal(list[0].uid, s.uid);
    assert.equal(list[0].refunded, 5);
    const m = await get(`users/${s.uid}/private/medal`);
    assert.equal(m.status, 'paid');
    assert.equal(m.refundCount, 0);
    assert.equal(m.updatedAt.toMillis(), before.updatedAt.toMillis());
    assert.equal((await get('payments/' + s.checkoutId)).refunded, 5);
  });

  it('(f) reembolso do programa conta billing.refundCount e bloqueia; chargeback depois não conta de novo', async () => {
    const p = person();
    const r = await call('signup', p);
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    const uid = (await admin.auth().getUserByEmail(p.email)).uid;
    const checkoutId = (await get(`users/${uid}/private/billing`)).checkoutId;
    await hook(checkoutPaid(uid, checkoutId));
    assert.equal((await get('users/' + uid)).access, 'active');
    await hook(payment('cardRefunded', checkoutId));
    await hook(payment('cardChargeback', checkoutId));
    const st = await programState(uid);
    assert.equal(st.access, 'blocked');
    assert.equal(st.billing.status, 'refunded');
    assert.equal(st.billing.refundCount, 1);
    assert.equal((await db.doc(`users/${uid}/private/medal`).get()).exists, false);
  });

  it('(g) pedido e linha financeira da medalha defeituosos não impedem o programa de ativar', async () => {
    const p = person();
    const r = await call('signup', p);
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    const uid = (await admin.auth().getUserByEmail(p.email)).uid;
    const checkoutId = (await get(`users/${uid}/private/billing`)).checkoutId;
    // Pedido da medalha com lixo e linha financeira da medalha corrompida.
    await db.doc(`users/${uid}/private/medal`).set({ status: 42, refundCount: 'x', checkoutId: { a: 1 } });
    const medalCo = 'checkout-medalha-defeituoso';
    await db.doc('checkouts/' + medalCo).set({ kind: 'medal', uid, value: 'x', status: 'active', createdAt: new Date(), expiresAt: new Date() });
    await db.doc('payments/' + medalCo).set({ parts: 'lixo', refunded: {}, status: 7, coupon: { a: 1 } });
    // Evento da medalha chega antes e é tratado (200), mesmo com tudo defeituoso.
    assert.equal((await hook(payment('pixReceived', medalCo, { paymentId: 'pay_g_medal' }))).status, 200);
    assert.equal((await hook(checkoutPaid(uid, checkoutId))).status, 200);
    assert.equal((await get('users/' + uid)).access, 'active');
    assert.equal((await get(`users/${uid}/private/billing`)).status, 'paid');
    assert.equal((await get('payments/' + checkoutId)).product, 'Do 0 aos 5 km');
    assert.equal((await get('payments/' + checkoutId)).kind, undefined);
  });

  for (const billingStatus of ['pending', 'refunded', 'blocked']) {
    it(`(h) checkout da medalha nunca toca billing nem access (billing do programa ${billingStatus})`, async () => {
      const s = await withOrder();
      const access = billingStatus === 'pending' ? 'pending' : 'blocked';
      await db.doc('users/' + s.uid).update({ access });
      await db.doc(`users/${s.uid}/private/billing`).update({ status: billingStatus === 'blocked' ? 'paid' : billingStatus });
      const before = await programState(s.uid);
      // Evento com externalReference do uid (como no programa), pagamento, reembolso, chargeback e parcial.
      for (const e of [
        checkoutPaid(s.uid, s.checkoutId),
        payment('pixReceived', s.checkoutId),
        payment('cardRefunded', s.checkoutId),
        payment('cardChargeback', s.checkoutId, { paymentId: 'pay_cb_h' }),
        payment('pixReceived', s.checkoutId, { event: 'PAYMENT_PARTIALLY_REFUNDED', paymentId: 'pay_pr_h' }),
        payment('cardRefunded', s.checkoutId, { event: 'PAYMENT_REPROVED_BY_RISK_ANALYSIS', paymentId: 'pay_rj_h' }),
      ]) assert.equal((await hook(e)).status, 200);
      assert.deepEqual(await programState(s.uid), before);
      const bill = await get(`users/${s.uid}/private/billing`);
      assert.equal(bill.refundCount, undefined);
      assert.equal(bill.paidAt, undefined);
    });
  }

  it('(h) pagamento do programa nunca marca a medalha, mesmo com pedido pendente', async () => {
    const s = await concluded();
    await call('startMedalCheckout', { useSignupAddress: true }, s.token);
    const before = await get(`users/${s.uid}/private/medal`);
    const programCheckout = 'checkout-programa-h';
    await db.doc('checkouts/' + programCheckout).set({ uid: s.uid, status: 'active', createdAt: new Date(), expiresAt: new Date() });
    await db.doc(`users/${s.uid}/private/billing`).update({ status: 'pending', checkoutId: programCheckout });
    await db.doc('users/' + s.uid).update({ access: 'pending' });
    await hook(checkoutPaid(s.uid, programCheckout));
    await hook(payment('pixReceived', programCheckout, { paymentId: 'pay_prog_h' }));
    assert.equal((await get('users/' + s.uid)).access, 'active');
    assert.deepEqual(await get(`users/${s.uid}/private/medal`), before);
  });

  it('(h) checkout que não é nosso, ou kind medal sem pedido: sem efeito no programa', async () => {
    const s = await signupOk();
    const before = await programState(s.uid);
    await hook(payment('pixReceived', 'checkout-de-outro-produto'));
    await db.doc('checkouts/orfao-medalha').set({ kind: 'medal', uid: s.uid, value: 35, status: 'active', createdAt: new Date(), expiresAt: new Date() });
    assert.equal((await hook(checkoutPaid(s.uid, 'orfao-medalha'))).status, 200);
    assert.deepEqual(await programState(s.uid), before);
    assert.deepEqual(await alertTypes(), ['unknown-uid']);
  });
});
