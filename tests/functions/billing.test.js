// Testes do cadastro, da retomada de pagamento e do webhook do Asaas no emulador
// (Auth + Firestore + Functions, projeto demo-letz) com o Asaas falso na porta 7777
// (functions/.env.local aponta ASAAS_BASE_URL para lá).
// Rode com: npm run test:functions
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { startFakeAsaas } from '../fake-asaas.mjs';

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

const PROJECT = 'demo-letz';
const FN = `http://127.0.0.1:5001/${PROJECT}/southamerica-east1`;
const AUTH = 'http://127.0.0.1:9099';
const MSG_EXISTS = 'Já existe um cadastro com este CPF ou e-mail. Entre com seu e-mail e senha ou fale com a Letz.';
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

async function call(name, data, idToken, extraHeaders = {}) {
  const headers = { 'content-type': 'application/json', ...extraHeaders };
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

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor: tempo esgotado');
    await new Promise((r) => setTimeout(r, 100));
  }
}

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
  for (const c of ['users', 'cpfs', 'checkouts', 'asaasEvents', 'config', 'rateLimits', 'testFaults', 'alerts']) {
    await db.recursiveDelete(db.collection(c));
  }
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  await fetch(`${fake.url}/__reset`, { method: 'POST' });
}

const alerts = async () => (await db.collection('alerts').get()).docs.map((d) => d.data());

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
    assert.equal(r.error.message, MSG_EXISTS);
  });

  it('signup: e-mail repetido → already-exists', async () => {
    const { p } = await signupOk();
    const other = person({ email: p.email });
    const r = await call('signup', other);
    assert.equal(r.error.status, 'ALREADY_EXISTS');
    assert.equal(r.error.message, MSG_EXISTS);
    // O CPF da segunda tentativa não fica preso.
    assert.equal((await db.doc('cpfs/' + other.cpf).get()).exists, false);
  });

  it('signup: mesma mensagem para CPF e e-mail repetidos', async () => {
    const { p } = await signupOk();
    const byCpf = await call('signup', person({ cpf: p.cpf }));
    const byEmail = await call('signup', person({ email: p.email }));
    assert.equal(byCpf.error.status, 'ALREADY_EXISTS');
    assert.equal(byEmail.error.status, 'ALREADY_EXISTS');
    assert.equal(byCpf.error.message, MSG_EXISTS);
    assert.equal(byEmail.error.message, byCpf.error.message);
  });

  it('signup: falha no batch remove usuário do Auth e libera CPF', async () => {
    // Falha injetada só no emulador (FUNCTIONS_EMULATOR) por testFaults/signup.
    await db.doc('testFaults/signup').set({ failBatch: true });
    const p = person();
    const r = await call('signup', p);
    assert.equal(r.error.status, 'INTERNAL');
    await assert.rejects(admin.auth().getUserByEmail(p.email));
    assert.equal((await db.doc('cpfs/' + p.cpf).get()).exists, false);
    assert.equal((await db.collection('users').get()).size, 0);
    await db.doc('testFaults/signup').delete();
    // O mesmo CPF e e-mail podem tentar de novo.
    await signupOk(p);
  });

  it('signup: CPF de conta pendente há mais de 24h pode ser usado', async () => {
    const old = await signupOk();
    await db.doc('users/' + old.uid).update({
      createdAt: admin.firestore.Timestamp.fromMillis(Date.now() - 25 * 3600e3),
    });
    const fresh = await signupOk(person({ cpf: old.p.cpf }));
    assert.equal((await get('cpfs/' + old.p.cpf)).uid, fresh.uid);
    assert.equal((await get('cpfs/' + old.p.cpf)).reclaimedFrom, old.uid);
    const oldBilling = await get(`users/${old.uid}/private/billing`);
    assert.equal(oldBilling.cpfReleased, true);
    assert.equal(oldBilling.status, 'pending');
    assert.equal((await get('users/' + old.uid)).access, 'pending');
    assert.equal((await get('checkouts/' + old.checkoutId)).status, 'canceled');
    const sent = await (await fetch(`${fake.url}/__checkouts`)).json();
    assert.equal(sent.find((c) => c.id === old.checkoutId).status, 'CANCELED');
    // A conta antiga não abre outro checkout.
    const token = await signIn(old.p.email, old.p.password);
    assert.equal((await call('resumeCheckout', {}, token)).error.status, 'FAILED_PRECONDITION');
  });

  it('signup: mesmo CPF e mesmo e-mail depois de 24h não trava a conta antiga', async () => {
    const old = await signupOk();
    await db.doc('users/' + old.uid).update({
      createdAt: admin.firestore.Timestamp.fromMillis(Date.now() - 25 * 3600e3),
    });
    const r = await call('signup', old.p);
    assert.equal(r.error.status, 'ALREADY_EXISTS');
    assert.equal(r.error.message, MSG_EXISTS);
    const cpfDoc = await get('cpfs/' + old.p.cpf);
    assert.equal(cpfDoc.uid, old.uid);
    const billing = await get(`users/${old.uid}/private/billing`);
    assert.equal(billing.cpfReleased, undefined);
    assert.equal(billing.status, 'pending');
    assert.equal((await get('checkouts/' + old.checkoutId)).status, 'active');
    const token = await signIn(old.p.email, old.p.password);
    const again = await call('resumeCheckout', {}, token);
    assert.equal(again.error, undefined, JSON.stringify(again.error));
    assert.equal(again.result.checkoutUrl, old.url);
  });

  it('signup: falha após reclaim devolve o CPF à conta antiga', async () => {
    const old = await signupOk();
    await db.doc('users/' + old.uid).update({
      createdAt: admin.firestore.Timestamp.fromMillis(Date.now() - 25 * 3600e3),
    });
    await db.doc('testFaults/signup').set({ failBatch: true });
    const p = person({ cpf: old.p.cpf });
    const r = await call('signup', p);
    assert.equal(r.error.status, 'INTERNAL');
    await assert.rejects(admin.auth().getUserByEmail(p.email));
    assert.equal((await get('cpfs/' + old.p.cpf)).uid, old.uid);
    const billing = await get(`users/${old.uid}/private/billing`);
    assert.equal(billing.cpfReleased, undefined);
    assert.equal((await get('checkouts/' + old.checkoutId)).status, 'active');
    const sent = await (await fetch(`${fake.url}/__checkouts`)).json();
    assert.equal(sent.find((c) => c.id === old.checkoutId).status, 'ACTIVE');
    const token = await signIn(old.p.email, old.p.password);
    assert.equal((await call('resumeCheckout', {}, token)).result.checkoutUrl, old.url);
  });

  it('signup: entre as fases a conta antiga não consegue retomar o pagamento', async () => {
    const old = await signupOk();
    await db.doc('users/' + old.uid).update({
      createdAt: admin.firestore.Timestamp.fromMillis(Date.now() - 25 * 3600e3),
    });
    // Checkout antigo vencido: sem o bloqueio, resumeCheckout abriria outro.
    await db.doc(`users/${old.uid}/private/billing`).update({
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() - 60000),
    });
    const token = await signIn(old.p.email, old.p.password);
    // Segura a função logo depois da fase 1 (só no emulador).
    await db.doc('testFaults/signup').set({ pauseAfterReserveMs: 6000 });
    const p = person({ cpf: old.p.cpf });
    const pending = call('signup', p);
    const pendingBy = await waitFor(async () => (await get(`users/${old.uid}/private/billing`)).cpfReclaimPendingBy);
    assert.equal((await get('cpfs/' + old.p.cpf)).reclaimedFrom, old.uid);
    assert.equal((await get(`users/${old.uid}/private/billing`)).cpfReleased, undefined);

    const r = await call('resumeCheckout', {}, token);
    assert.equal(r.error && r.error.status, 'FAILED_PRECONDITION');
    assert.equal(r.error.message, 'Este cadastro foi encerrado. Fale com a Letz.');
    const sent = await (await fetch(`${fake.url}/__checkouts`)).json();
    assert.equal(sent.length, 1);

    const done = await pending;
    assert.equal(done.error, undefined, JSON.stringify(done.error));
    const fresh = await admin.auth().getUserByEmail(p.email);
    assert.equal(pendingBy, fresh.uid);
    const billing = await get(`users/${old.uid}/private/billing`);
    assert.equal(billing.cpfReleased, true);
    assert.equal(billing.cpfReclaimPendingBy, undefined);
  });

  it('signup: falha no finishReclaim deixa marcador e bloqueia retomada', async () => {
    const old = await signupOk();
    await db.doc('users/' + old.uid).update({
      createdAt: admin.firestore.Timestamp.fromMillis(Date.now() - 25 * 3600e3),
    });
    await db.doc('testFaults/signup').set({ failFinishReclaim: true });
    const fresh = await signupOk(person({ cpf: old.p.cpf }));
    assert.equal((await get('cpfs/' + old.p.cpf)).uid, fresh.uid);
    const billing = await get(`users/${old.uid}/private/billing`);
    assert.equal(billing.cpfReclaimPendingBy, fresh.uid);
    assert.equal(billing.cpfReleased, undefined);

    const token = await signIn(old.p.email, old.p.password);
    const r = await call('resumeCheckout', {}, token);
    assert.equal(r.error && r.error.status, 'FAILED_PRECONDITION');
    assert.equal(r.error.message, 'Este cadastro foi encerrado. Fale com a Letz.');

    // Se mesmo assim o checkout antigo for pago: ativa e marca cpfConflict.
    assert.equal((await hook(payment('pixReceived', old.checkoutId))).status, 200);
    assert.equal((await get('users/' + old.uid)).access, 'active');
    const paid = await get(`users/${old.uid}/private/billing`);
    assert.equal(paid.status, 'paid');
    assert.equal(paid.cpfConflict, true);
  });

  it('signup: rollback limpa cpfReclaimPendingBy', async () => {
    const old = await signupOk();
    await db.doc('users/' + old.uid).update({
      createdAt: admin.firestore.Timestamp.fromMillis(Date.now() - 25 * 3600e3),
    });
    await db.doc('testFaults/signup').set({ pauseAfterReserveMs: 4000, failBatch: true });
    const p = person({ cpf: old.p.cpf });
    const pending = call('signup', p);
    // O marcador existe entre as fases...
    await waitFor(async () => (await get(`users/${old.uid}/private/billing`)).cpfReclaimPendingBy);
    const r = await pending;
    assert.equal(r.error.status, 'INTERNAL');
    // ...e some quando a tentativa é desfeita.
    assert.equal((await get('cpfs/' + old.p.cpf)).uid, old.uid);
    const billing = await get(`users/${old.uid}/private/billing`);
    assert.equal(billing.cpfReclaimPendingBy, undefined);
    assert.equal(billing.cpfReleased, undefined);
    await db.doc('testFaults/signup').delete();
    const token = await signIn(old.p.email, old.p.password);
    assert.equal((await call('resumeCheckout', {}, token)).result.checkoutUrl, old.url);
  });

  it('signup: CPF de pendente recente não é liberado', async () => {
    const old = await signupOk();
    const r = await call('signup', person({ cpf: old.p.cpf }));
    assert.equal(r.error.status, 'ALREADY_EXISTS');
    assert.equal((await get('cpfs/' + old.p.cpf)).uid, old.uid);
  });

  it('signup: CPF de conta paga nunca é liberado', async () => {
    const old = await signupOk();
    assert.equal((await hook(checkoutPaid(old.uid, old.checkoutId))).status, 200);
    await db.doc('users/' + old.uid).update({
      createdAt: admin.firestore.Timestamp.fromMillis(Date.now() - 30 * 24 * 3600e3),
    });
    const r = await call('signup', person({ cpf: old.p.cpf }));
    assert.equal(r.error.status, 'ALREADY_EXISTS');
    assert.equal((await get('cpfs/' + old.p.cpf)).uid, old.uid);
    assert.equal((await get(`users/${old.uid}/private/billing`)).cpfReleased, undefined);
  });

  const ipDoc = (ip) => 'rateLimits/signup_' + createHash('sha256').update(ip).digest('hex');
  const seedLimit = (path, count) => db.doc(path).set({
    windowStart: admin.firestore.Timestamp.now(), count, expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 3600e3),
  });

  it('signup: 21ª tentativa do mesmo IP em 1h é bloqueada', async () => {
    const h = { 'x-forwarded-for': '203.0.113.5' };
    await seedLimit(ipDoc('203.0.113.5'), 19);
    const ok = await call('signup', person(), null, h);
    assert.equal(ok.error, undefined, JSON.stringify(ok.error));
    const p = person();
    const r = await call('signup', p, null, h);
    assert.equal(r.error.status, 'RESOURCE_EXHAUSTED');
    assert.equal(r.error.message, 'Muitas tentativas. Tente de novo em alguns minutos.');
    await assert.rejects(admin.auth().getUserByEmail(p.email));
    assert.equal((await get(ipDoc('203.0.113.5'))).count, 20);
  });

  it('signup: limite global não bloqueia compradores', async () => {
    await seedLimit('rateLimits/signup_success', 500);
    await seedLimit('rateLimits/signup_global', 9999); // doc antigo, ignorado
    const r = await call('signup', person(), null, { 'x-forwarded-for': '203.0.113.51' });
    assert.equal(r.error, undefined, JSON.stringify(r.error));
  });

  it('signup: pico de cadastros gera alerta sem bloquear', async () => {
    await seedLimit('rateLimits/signup_success', 300);
    const one = await call('signup', person(), null, { 'x-forwarded-for': '203.0.113.60' });
    const two = await call('signup', person(), null, { 'x-forwarded-for': '203.0.113.61' });
    assert.equal(one.error, undefined, JSON.stringify(one.error));
    assert.equal(two.error, undefined, JSON.stringify(two.error));
    const spikes = (await alerts()).filter((a) => a.type === 'signup-spike');
    assert.equal(spikes.length, 1);
    assert.equal(spikes[0].count, 301);
    assert.equal(spikes[0].resolved, false);
  });

  it('signup: x-forwarded-for forjado não burla o limite', async () => {
    // Só o último salto (o que o front-end do Google acrescenta) conta.
    await seedLimit(ipDoc('198.51.100.7'), 20);
    const xff = (i) => ({ 'x-forwarded-for': `10.0.0.${i}, 203.0.113.${i}, 198.51.100.7` });
    const r = await call('signup', person(), null, xff(99));
    assert.equal(r.error.status, 'RESOURCE_EXHAUSTED');
    // Outro IP real (último salto diferente) não é afetado.
    const other = await call('signup', person(), null, { 'x-forwarded-for': '10.0.0.1, 198.51.100.8' });
    assert.equal(other.error, undefined, JSON.stringify(other.error));
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

  it('resumeCheckout: corrida com pagamento não sobrescreve checkout pago', async () => {
    const { p, uid, url, checkoutId } = await signupOk();
    await db.doc(`users/${uid}/private/billing`).update({
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() - 60000),
    });
    const token = await signIn(p.email, p.password);
    // O Asaas demora a criar o novo checkout; nesse meio tempo chega o pagamento do antigo.
    await fetch(`${fake.url}/__delay`, { method: 'POST', body: JSON.stringify({ checkouts: 4000 }) });
    const pending = call('resumeCheckout', {}, token);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await hook(checkoutPaid(uid, checkoutId))).status, 200);
    const r = await pending;
    assert.equal(r.error && r.error.status, 'FAILED_PRECONDITION');

    const billing = await get(`users/${uid}/private/billing`);
    assert.equal(billing.status, 'paid');
    assert.equal(billing.checkoutId, checkoutId);
    assert.equal(billing.url, url);
    assert.equal((await get('users/' + uid)).access, 'active');
    const sent = await (await fetch(`${fake.url}/__checkouts`)).json();
    assert.equal(sent.length, 2);
    const fresh = sent.find((c) => c.id !== checkoutId);
    assert.equal(fresh.status, 'CANCELED');
    assert.equal((await get('checkouts/' + fresh.id)).status, 'canceled');
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

  it('webhook: pago atrasado com billing reembolsado não reativa', async () => {
    const { uid, checkoutId } = await signupOk();
    await hook(checkoutPaid(uid, checkoutId));
    await hook(payment('cardRefunded', checkoutId));
    assert.equal((await get('users/' + uid)).access, 'blocked');
    // Sem checkouts/{id} (ou com status perdido), vale o billing.
    await db.doc('checkouts/' + checkoutId).delete();
    assert.equal((await hook(checkoutPaid(uid, checkoutId))).status, 200);
    assert.equal((await get('users/' + uid)).access, 'blocked');
    assert.equal((await get(`users/${uid}/private/billing`)).status, 'refunded');
  });

  it('webhook: uid do evento diferente do checkout vale o do checkout', async () => {
    const a = await signupOk();
    const b = await signupOk();
    assert.equal((await hook(checkoutPaid(b.uid, a.checkoutId))).status, 200);
    assert.equal((await get('users/' + a.uid)).access, 'active');
    assert.equal((await get('users/' + b.uid)).access, 'pending');
    assert.equal((await get('asaasEvents/' + (await db.collection('asaasEvents').get()).docs[0].id)).uid, a.uid);
  });

  it('webhook: pagamento de conta com CPF liberado marca cpfConflict', async () => {
    const old = await signupOk();
    await db.doc('users/' + old.uid).update({
      createdAt: admin.firestore.Timestamp.fromMillis(Date.now() - 25 * 3600e3),
    });
    await signupOk(person({ cpf: old.p.cpf }));
    assert.equal((await get(`users/${old.uid}/private/billing`)).cpfReleased, true);
    // O checkout antigo não cancelou a tempo e a pessoa pagou: ativa, mas sinaliza.
    assert.equal((await hook(payment('pixReceived', old.checkoutId))).status, 200);
    assert.equal((await get('users/' + old.uid)).access, 'active');
    const billing = await get(`users/${old.uid}/private/billing`);
    assert.equal(billing.status, 'paid');
    assert.equal(billing.cpfConflict, true);
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

  it('webhook: uid desconhecido responde 200 e gera alerta unknown-uid', async () => {
    assert.equal((await hook(payment('pixReceived', 'checkout-que-nao-existe'))).status, 200);
    assert.equal((await alerts()).length, 0); // checkout desconhecido, sem uid: não é nosso
    const e = checkoutPaid('uid-que-nao-existe', 'outro-checkout');
    assert.equal((await hook(e)).status, 200);
    const list = await alerts();
    assert.equal(list.length, 1);
    assert.equal(list[0].type, 'unknown-uid');
    assert.equal(list[0].uid, 'uid-que-nao-existe');
    assert.equal(list[0].eventId, e.id);
    assert.equal(list[0].resolved, false);
  });

  it('webhook: externalReference/checkout com barras ou espaços → 200 e nada gravado', async () => {
    for (const bad of ['pedido/123', 'a b', '../users/x', 'x'.repeat(200), 'users/a/private/billing']) {
      assert.equal((await hook(checkoutPaid(bad, 'ck-foreign-1'))).status, 200);
      assert.equal((await hook(checkoutPaid('uid-ok', bad))).status, 200);
      assert.equal((await hook(payment('pixReceived', bad))).status, 200);
    }
    const e = checkoutPaid('uid-ok', 'ck-1', 'evt/com/barra');
    assert.equal((await hook(e)).status, 200);
    assert.equal((await db.collection('users').get()).size, 0);
    assert.equal((await db.collection('alerts').get()).size, 0);
    // evento com id inválido não é gravado (nem com '/' trocado por '_').
    assert.equal((await db.doc('asaasEvents/evt_com_barra').get()).exists, false);
  });

  it('webhook: cartão reprovado pela análise de risco bloqueia', async () => {
    const { uid, checkoutId } = await signupOk();
    await hook(checkoutPaid(uid, checkoutId));
    assert.equal((await get('users/' + uid)).access, 'active');
    const res = await hook(payment('cardConfirmed', checkoutId, { event: 'PAYMENT_REPROVED_BY_RISK_ANALYSIS' }));
    assert.equal(res.status, 200);
    assert.equal((await get('users/' + uid)).access, 'blocked');
    assert.equal((await get(`users/${uid}/private/billing`)).status, 'rejected');
    assert.equal((await get('checkouts/' + checkoutId)).status, 'rejected');
  });

  it('webhook: rejeitado de checkout ainda aberto não o fecha e o pagamento seguinte ativa', async () => {
    const { uid, checkoutId } = await signupOk();
    await hook(payment('cardConfirmed', checkoutId, { event: 'PAYMENT_REPROVED_BY_RISK_ANALYSIS' }));
    assert.equal((await get('checkouts/' + checkoutId)).status, 'active');
    assert.equal((await get('users/' + uid)).access, 'pending');
    assert.equal((await hook(payment('cardConfirmed', checkoutId))).status, 200);
    assert.equal((await get('users/' + uid)).access, 'active');
  });

  it('webhook: pago em checkout já fechado gera alerta', async () => {
    const { uid, checkoutId } = await signupOk();
    await hook(payment('cardConfirmed', checkoutId));
    await hook(payment('cardConfirmed', checkoutId, { event: 'PAYMENT_REPROVED_BY_RISK_ANALYSIS' }));
    assert.equal((await get('users/' + uid)).access, 'blocked');
    const e = payment('pixReceived', checkoutId);
    await hook(e);
    assert.equal((await get('users/' + uid)).access, 'blocked');
    const list = (await alerts()).filter((a) => a.type === 'paid-closed-checkout');
    assert.equal(list.length, 1);
    assert.equal(list[0].uid, uid);
    assert.equal(list[0].checkoutId, checkoutId);
    assert.equal(list[0].eventId, e.id);
  });

  it('webhook: reembolso antes do pago fecha o checkout e o pago tardio gera alerta sem ativar', async () => {
    const { uid, checkoutId } = await signupOk();
    await hook(payment('cardRefunded', checkoutId));
    assert.equal((await get('checkouts/' + checkoutId)).status, 'refunded');
    assert.equal((await get('users/' + uid)).access, 'pending');
    await hook(payment('cardConfirmed', checkoutId));
    assert.equal((await get('users/' + uid)).access, 'pending');
    assert.equal((await alerts()).filter((a) => a.type === 'paid-closed-checkout' && a.uid === uid).length, 1);
  });

  it('webhook: captura recusada do cartão também bloqueia', async () => {
    const { uid, checkoutId } = await signupOk();
    await hook(payment('cardConfirmed', checkoutId));
    await hook(payment('cardConfirmed', checkoutId, { event: 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED' }));
    assert.equal((await get('users/' + uid)).access, 'blocked');
  });

  it('webhook: duplicate-payment e cpf-conflict geram alerta uma vez só', async () => {
    const { uid, checkoutId } = await signupOk();
    await hook(checkoutPaid(uid, checkoutId));
    const other = 'checkout-duplicado-2';
    await db.doc('checkouts/' + other).set({ uid, status: 'active', createdAt: new Date(), expiresAt: new Date() });
    await hook(payment('pixReceived', other));
    await hook(payment('pixReceived', other, { n: 2 }));
    const list = await alerts();
    assert.equal(list.filter((a) => a.type === 'duplicate-payment').length, 1);
    assert.equal(list[0].uid, uid);

    const old = await signupOk();
    await db.doc('users/' + old.uid).update({ createdAt: admin.firestore.Timestamp.fromMillis(Date.now() - 25 * 3600e3) });
    await signupOk(person({ cpf: old.p.cpf }));
    await hook(payment('pixReceived', old.checkoutId));
    assert.equal((await alerts()).filter((a) => a.type === 'cpf-conflict').length, 1);
  });

  it('webhook: evento ignorado responde 200', async () => {
    const { uid, checkoutId } = await signupOk();
    assert.equal((await hook(payment('pixCreated', checkoutId))).status, 200);
    assert.equal((await get('users/' + uid)).access, 'pending');
  });
});
