// Testes do cadastro, da retomada de pagamento e do webhook do Asaas no emulador
// (Auth + Firestore + Functions, projeto demo-letz) com o Asaas falso na porta 7777
// (functions/.env.local aponta ASAAS_BASE_URL para lá).
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
function secretLocal(name) {
  const text = readFileSync(new URL('../../functions/.secret.local', import.meta.url), 'utf8');
  const line = text.split('\n').find((l) => l.startsWith(name + '='));
  return line ? line.slice(name.length + 1).trim() : '';
}
const WEBHOOK_TOKEN = secretLocal('ASAAS_WEBHOOK_TOKEN');

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

function hook(body, token = WEBHOOK_TOKEN) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['asaas-access-token'] = token;
  return fetch(`${FN}/asaasWebhook`, { method: 'POST', headers, body: JSON.stringify(body) });
}

// CPFs válidos gerados na hora (dígitos verificadores calculados).
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
    name: 'Aluna Teste ' + seq,
    email: `aluna${seq}-${Date.now()}@exemplo.com`,
    password: 'senha-forte-123',
    cpf: makeCpf(),
    phone: '(81) 99999-0000',
    acceptPolicy: true,
    ...extra,
  };
}

async function signupOk(p = person()) {
  const r = await call('signup', p);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  const user = await admin.auth().getUserByEmail(p.email);
  const billing = (await db.doc(`users/${user.uid}/private/billing`).get()).data();
  return { p, uid: user.uid, url: r.result.checkoutUrl, checkoutId: billing.checkoutId };
}

const get = async (path) => (await db.doc(path).get()).data();

function checkoutPaid(uid, checkoutId, id = 'evt_checkout_' + Math.random()) {
  const e = structuredClone(events.checkoutPaidPix);
  e.id = id;
  e.checkout.id = checkoutId;
  e.checkout.externalReference = uid;
  return e;
}

function payment(fixture, checkoutId, { id, paymentId, n, event } = {}) {
  const e = structuredClone(events[fixture]);
  e.id = id || 'evt_' + fixture + '_' + Math.random();
  if (event) e.event = event;
  e.payment.checkoutSession = checkoutId;
  if (paymentId) e.payment.id = paymentId;
  if (n) {
    e.payment.installmentNumber = n;
    e.payment.description = `Parcela ${n} de 12.`;
  }
  return e;
}

async function wipe() {
  for (const c of ['users', 'cpfs', 'checkouts', 'asaasEvents', 'config']) {
    await db.recursiveDelete(db.collection(c));
  }
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  await fetch(`${fake.url}/__reset`, { method: 'POST' });
}

describe('cadastro, retomada e webhook', () => {
  before(async () => {
    assert.ok(WEBHOOK_TOKEN, 'functions/.secret.local precisa de ASAAS_WEBHOOK_TOKEN');
    fake = await startFakeAsaas({ port: 7777 });
  });
  beforeEach(wipe);
  after(async () => {
    await wipe();
    await fake.close();
    await admin.app().delete();
  });

  it('signup: cria conta pendente, cpf reservado e devolve checkoutUrl', async () => {
    const p = person({ cpf: '' });
    const cpf = makeCpf();
    p.cpf = `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
    const r = await call('signup', p);
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    assert.match(r.result.checkoutUrl, /^http:\/\/127\.0\.0\.1:7777\/checkoutSession\/show\//);

    const user = await admin.auth().getUserByEmail(p.email);
    const u = await get('users/' + user.uid);
    assert.equal(u.access, 'pending');
    assert.equal(u.points, 0);
    assert.equal(u.done, 0);
    assert.equal(u.name, p.name);
    assert.equal(u.handle, '');
    assert.equal(u.photoURL, '');
    assert.equal(u.profiled, false);
    assert.equal(u.welcomed, false);
    assert.ok(u.createdAt);

    const prof = await get(`users/${user.uid}/private/profile`);
    assert.equal(prof.cpf, cpf);
    assert.equal(prof.phone, '81999990000');
    assert.equal(prof.email, p.email);
    assert.ok(prof.policyAcceptedAt);

    assert.equal((await get('cpfs/' + cpf)).uid, user.uid);

    const billing = await get(`users/${user.uid}/private/billing`);
    assert.equal(billing.status, 'pending');
    assert.equal(billing.url, r.result.checkoutUrl);
    assert.ok(billing.checkoutId);
    assert.ok(billing.expiresAt.toMillis() > Date.now());

    const co = await get('checkouts/' + billing.checkoutId);
    assert.equal(co.uid, user.uid);
    assert.equal(co.status, 'active');

    const sent = await (await fetch(`${fake.url}/__checkouts`)).json();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].externalReference, user.uid);
    assert.equal(sent[0].items[0].value, 159);
    assert.equal(sent[0].installment.maxInstallmentCount, 12);
    assert.equal(sent[0].callback.successUrl, 'http://localhost:5050/#/confirmando');
  });

  it('signup: CPF repetido → already-exists', async () => {
    const { p } = await signupOk();
    const r = await call('signup', person({ cpf: p.cpf }));
    assert.equal(r.error.status, 'ALREADY_EXISTS');
    assert.equal(r.error.message, 'Este CPF já tem cadastro. Entre com seu e-mail e senha.');
  });

  it('signup: e-mail repetido → already-exists', async () => {
    const { p } = await signupOk();
    const other = person({ email: p.email });
    const r = await call('signup', other);
    assert.equal(r.error.status, 'ALREADY_EXISTS');
    assert.equal(r.error.message, 'Este e-mail já tem cadastro. Entre com seu e-mail e senha.');
    // O CPF da segunda tentativa não fica preso.
    assert.equal((await db.doc('cpfs/' + other.cpf).get()).exists, false);
  });

  it('signup: CPF inválido → invalid-argument', async () => {
    const r = await call('signup', person({ cpf: '123.456.789-00' }));
    assert.equal(r.error.status, 'INVALID_ARGUMENT');
  });

  it('signup: vendas fechadas → failed-precondition', async () => {
    await db.doc('config/app').set({ salesOpen: false });
    const p = person();
    const r = await call('signup', p);
    assert.equal(r.error.status, 'FAILED_PRECONDITION');
    await assert.rejects(admin.auth().getUserByEmail(p.email));
  });

  it('signup: falha no Asaas permite retomar', async () => {
    await fetch(`${fake.url}/__fail`, { method: 'POST', body: JSON.stringify({ checkouts: true }) });
    const p = person();
    const r = await call('signup', p);
    assert.equal(r.error.status, 'UNAVAILABLE');

    const user = await admin.auth().getUserByEmail(p.email);
    assert.equal((await get('cpfs/' + p.cpf)).uid, user.uid);
    assert.equal((await get('users/' + user.uid)).access, 'pending');

    await fetch(`${fake.url}/__fail`, { method: 'POST', body: JSON.stringify({ checkouts: false }) });
    const token = await signIn(p.email, p.password);
    const again = await call('resumeCheckout', {}, token);
    assert.equal(again.error, undefined, JSON.stringify(again.error));
    assert.match(again.result.checkoutUrl, /checkoutSession\/show\//);
    const billing = await get(`users/${user.uid}/private/billing`);
    assert.equal(billing.url, again.result.checkoutUrl);
    assert.equal((await get('checkouts/' + billing.checkoutId)).uid, user.uid);
  });

  it('resumeCheckout: checkout válido é reaproveitado', async () => {
    const { p, url } = await signupOk();
    const token = await signIn(p.email, p.password);
    const r = await call('resumeCheckout', {}, token);
    assert.equal(r.result.checkoutUrl, url);
    const sent = await (await fetch(`${fake.url}/__checkouts`)).json();
    assert.equal(sent.length, 1);
  });

  it('resumeCheckout: checkout vencido cancela o antigo e cria outro', async () => {
    const { p, uid, url, checkoutId } = await signupOk();
    await db.doc(`users/${uid}/private/billing`).update({
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() - 60000),
    });
    const token = await signIn(p.email, p.password);
    const r = await call('resumeCheckout', {}, token);
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    assert.notEqual(r.result.checkoutUrl, url);

    const billing = await get(`users/${uid}/private/billing`);
    assert.notEqual(billing.checkoutId, checkoutId);
    assert.equal(billing.url, r.result.checkoutUrl);
    assert.ok(billing.expiresAt.toMillis() > Date.now());
    assert.equal((await get('checkouts/' + checkoutId)).status, 'canceled');
    assert.equal((await get('checkouts/' + billing.checkoutId)).status, 'active');

    const sent = await (await fetch(`${fake.url}/__checkouts`)).json();
    assert.equal(sent.find((c) => c.id === checkoutId).status, 'CANCELED');
    assert.equal(sent.find((c) => c.id === billing.checkoutId).status, 'ACTIVE');
  });

  it('resumeCheckout: sem login → unauthenticated', async () => {
    const r = await call('resumeCheckout', {});
    assert.equal(r.error.status, 'UNAUTHENTICATED');
  });

  it('resumeCheckout: pago → failed-precondition', async () => {
    const { p, uid, checkoutId } = await signupOk();
    assert.equal((await hook(checkoutPaid(uid, checkoutId))).status, 200);
    const token = await signIn(p.email, p.password);
    const r = await call('resumeCheckout', {}, token);
    assert.equal(r.error.status, 'FAILED_PRECONDITION');
  });

  it('webhook: token errado → 401', async () => {
    const { uid, checkoutId } = await signupOk();
    assert.equal((await hook(checkoutPaid(uid, checkoutId), 'token-errado')).status, 401);
    assert.equal((await hook(checkoutPaid(uid, checkoutId), null)).status, 401);
    assert.equal((await get('users/' + uid)).access, 'pending');
    assert.equal((await db.collection('asaasEvents').get()).size, 0);
  });

  it('webhook: pago ativa conta', async () => {
    const { uid, checkoutId } = await signupOk();
    const res = await hook(payment('pixReceived', checkoutId));
    assert.equal(res.status, 200);
    assert.equal((await get('users/' + uid)).access, 'active');
    const billing = await get(`users/${uid}/private/billing`);
    assert.equal(billing.status, 'paid');
    assert.equal(billing.method, 'PIX');
    assert.ok(billing.paidAt);
    assert.equal((await get('checkouts/' + checkoutId)).status, 'paid');
  });

  it('webhook: CHECKOUT_PAID resolve o uid pelo externalReference', async () => {
    const { uid, checkoutId } = await signupOk();
    assert.equal((await hook(checkoutPaid(uid, checkoutId))).status, 200);
    assert.equal((await get('users/' + uid)).access, 'active');
    assert.equal((await get(`users/${uid}/private/billing`)).status, 'paid');
  });

  it('webhook: evento repetido ativa uma vez só', async () => {
    const { uid, checkoutId } = await signupOk();
    const e = checkoutPaid(uid, checkoutId, 'evt_repetido_1');
    assert.equal((await hook(e)).status, 200);
    const first = await get(`users/${uid}/private/billing`);
    assert.equal((await hook(e)).status, 200);
    const evs = await db.collection('asaasEvents').get();
    assert.equal(evs.size, 1);
    assert.equal(evs.docs[0].id, 'evt_repetido_1');
    assert.equal((await get('users/' + uid)).access, 'active');
    const second = await get(`users/${uid}/private/billing`);
    assert.equal(second.paidAt.toMillis(), first.paidAt.toMillis());
  });

  it('webhook: 12 PAYMENT_CONFIRMED do cartão parcelado ativam uma vez e registram parcelas', async () => {
    const { uid, checkoutId } = await signupOk();
    const all = Array.from({ length: 12 }, (_, i) =>
      payment('cardConfirmed', checkoutId, { id: `evt_parcela_${i + 1}`, paymentId: `pay_parcela_${i + 1}`, n: i + 1 }));

    assert.equal((await hook(all[0])).status, 200);
    const userSnap1 = await db.doc('users/' + uid).get();
    const billing1 = await get(`users/${uid}/private/billing`);
    assert.equal(userSnap1.data().access, 'active');

    const statuses = await Promise.all(all.slice(1).map((e) => hook(e).then((r) => r.status)));
    assert.deepEqual(statuses, Array(11).fill(200));

    const userSnap2 = await db.doc('users/' + uid).get();
    assert.equal(userSnap2.data().access, 'active');
    // users/{uid} não foi reescrito pelas parcelas 2..12.
    assert.equal(userSnap2.updateTime.toMillis(), userSnap1.updateTime.toMillis());

    const billing = await get(`users/${uid}/private/billing`);
    assert.equal(billing.status, 'paid');
    assert.equal(billing.method, 'CREDIT_CARD');
    assert.equal(billing.installments, 12);
    assert.equal(billing.paidAt.toMillis(), billing1.paidAt.toMillis());
    assert.equal(billing.duplicate || false, false);
    assert.equal((await db.collection('asaasEvents').get()).size, 12);
  });

  it('webhook: reembolso bloqueia', async () => {
    const { uid, checkoutId } = await signupOk();
    await hook(payment('cardConfirmed', checkoutId));
    assert.equal((await get('users/' + uid)).access, 'active');
    const res = await hook(payment('cardRefunded', checkoutId));
    assert.equal(res.status, 200);
    assert.equal((await get('users/' + uid)).access, 'blocked');
    assert.equal((await get(`users/${uid}/private/billing`)).status, 'refunded');
    assert.equal((await get('checkouts/' + checkoutId)).status, 'refunded');
  });

  it('webhook: chargeback bloqueia', async () => {
    const { uid, checkoutId } = await signupOk();
    await hook(payment('cardConfirmed', checkoutId));
    assert.equal((await hook(payment('cardChargeback', checkoutId))).status, 200);
    assert.equal((await get('users/' + uid)).access, 'blocked');
    assert.equal((await get(`users/${uid}/private/billing`)).status, 'chargeback');
  });

  it('webhook: evento pago atrasado depois de reembolso não reativa', async () => {
    const { uid, checkoutId } = await signupOk();
    await hook(payment('cardConfirmed', checkoutId, { n: 1 }));
    await hook(payment('cardRefunded', checkoutId));
    assert.equal((await get('users/' + uid)).access, 'blocked');
    const late = payment('cardConfirmed', checkoutId, { paymentId: 'pay_parcela_7', n: 7, event: 'PAYMENT_RECEIVED' });
    assert.equal((await hook(late)).status, 200);
    assert.equal((await hook(checkoutPaid(uid, checkoutId))).status, 200);
    assert.equal((await get('users/' + uid)).access, 'blocked');
    assert.equal((await get(`users/${uid}/private/billing`)).status, 'refunded');
  });

  it('webhook: pagamento de segundo checkout marca duplicate', async () => {
    const { uid, checkoutId } = await signupOk();
    await hook(checkoutPaid(uid, checkoutId));
    const other = 'checkout-duplicado-1';
    await db.doc('checkouts/' + other).set({ uid, status: 'active', createdAt: new Date(), expiresAt: new Date() });
    assert.equal((await hook(payment('pixReceived', other))).status, 200);
    const billing = await get(`users/${uid}/private/billing`);
    assert.equal(billing.duplicate, true);
    assert.equal(billing.checkoutId, checkoutId);
    assert.equal(billing.status, 'paid');
    assert.equal((await get('users/' + uid)).access, 'active');
    assert.equal((await get('checkouts/' + other)).status, 'paid');
  });

  it('webhook: uid desconhecido responde 200', async () => {
    assert.equal((await hook(payment('pixReceived', 'checkout-que-nao-existe'))).status, 200);
    assert.equal((await hook(checkoutPaid('uid-que-nao-existe', 'outro-checkout'))).status, 200);
  });

  it('webhook: evento ignorado responde 200', async () => {
    const { uid, checkoutId } = await signupOk();
    assert.equal((await hook(payment('pixCreated', checkoutId))).status, 200);
    assert.equal((await get('users/' + uid)).access, 'pending');
  });
});
