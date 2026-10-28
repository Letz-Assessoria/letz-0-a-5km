// Testes do checkout da medalha (startMedalCheckout) e do mailer no emulador
// (Auth + Firestore + Functions, projeto demo-letz) com o Asaas falso na porta 7777.
// Rode com: npm run test:functions
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startFakeAsaas } from '../fake-asaas.mjs';

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

const PROJECT = 'demo-letz';
const FN = `http://127.0.0.1:5001/${PROJECT}/southamerica-east1`;
const AUTH = 'http://127.0.0.1:9099';

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
  for (const c of ['users', 'posts', 'cpfs', 'checkouts', 'asaasEvents', 'config', 'rateLimits', 'testFaults', 'alerts', 'payments']) {
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
    await admin.app().delete();
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

describe('mailer', () => {
  it('sem GMAIL_APP_PASSWORD usa o transporte falso e guarda a última mensagem', async () => {
    const mailer = require('./src/mailer.js');
    const r = await mailer.sendMail({ to: 'a@b.com', subject: 'Oi', text: 'Texto' });
    assert.deepEqual(r, { sent: true, fake: true });
    assert.equal(mailer.__lastFake().to, 'a@b.com');
    assert.equal(mailer.__lastFake().subject, 'Oi');
  });

  it('nunca lança: dados faltando devolve sent:false', async () => {
    const mailer = require('./src/mailer.js');
    assert.deepEqual(await mailer.sendMail({ to: 'a@b.com' }), { sent: false });
  });
});
