// createPartner e resgate de cupom no signup (emulador Auth + Firestore + Functions).
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
const MSG_COUPON = 'Cupom inválido ou esgotado.';

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
let fake;
let seq = 0;

async function call(name, data, idToken) {
  const headers = { 'content-type': 'application/json' };
  if (idToken) headers.authorization = 'Bearer ' + idToken;
  const res = await fetch(`${FN}/${name}`, { method: 'POST', headers, body: JSON.stringify({ data }) });
  const body = await res.json();
  return body.error ? { error: body.error } : { result: body.result };
}

async function signIn(email, password) {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const b = await res.json();
  if (!b.idToken) throw new Error('login falhou: ' + JSON.stringify(b));
  return b.idToken;
}

async function makeUserToken(isAdmin) {
  seq += 1;
  const email = `${isAdmin ? 'trein' : 'aluno'}${seq}-${Date.now()}@exemplo.com`;
  const u = await admin.auth().createUser({ email, password: 'senha-forte-123' });
  if (isAdmin) await admin.auth().setCustomUserClaims(u.uid, { admin: true });
  return signIn(email, 'senha-forte-123');
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
    name: 'Aluna Cupom ' + seq, email: `cupom${seq}-${Date.now()}@exemplo.com`, password: 'senha-forte-123',
    cpf: makeCpf(), phone: '(81) 99999-0000', acceptPolicy: true, ...extra,
  };
}
const ADDR = { cep: '50050-000', street: 'Rua da Aurora', number: '100', complement: '', district: 'Boa Vista', city: 'Recife', uf: 'PE' };

function partnerData(extra = {}) {
  seq += 1;
  return { name: 'Parceiro ' + seq, email: `parceiro${seq}-${Date.now()}@exemplo.com`, phone: '(81) 98888-7777', code: 'PARC' + seq + 'X', maxUses: 20, ...extra };
}

async function seedCoupon(code, extra = {}) {
  await db.doc('coupons/' + code).set({
    code, partnerUid: 'p1', partnerName: 'Parceiro', active: true, maxUses: 5, usedCount: 0, expiresAt: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(), ...extra,
  });
}

const get = async (path) => (await db.doc(path).get()).data();
const checkouts = async () => (await fetch(`${fake.url}/__checkouts`)).json();

async function wipe() {
  for (const c of ['users', 'cpfs', 'checkouts', 'asaasEvents', 'config', 'rateLimits', 'testFaults', 'alerts', 'payments', 'coupons']) {
    await db.recursiveDelete(db.collection(c));
  }
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  await fetch(`${fake.url}/__reset`, { method: 'POST' });
}

describe('parceiros e cupons', () => {
  before(async () => { fake = await startFakeAsaas({ port: 7777 }); });
  beforeEach(wipe);
  after(async () => { await wipe(); await fake.close(); await admin.app().delete(); });

  describe('createPartner', () => {
    it('admin cria Auth, users, profile, billing e cupom; devolve link de reset', async () => {
      const token = await makeUserToken(true);
      const d = partnerData({ code: 'maria20', maxUses: 7, expiresAt: '2099-12-31' });
      const r = await call('createPartner', d, token);
      assert.equal(r.error, undefined, JSON.stringify(r.error));
      assert.equal(r.result.code, 'MARIA20');
      assert.match(r.result.resetLink, /^https?:\/\//);
      assert.match(r.result.resetLink, /oobCode=/);
      const user = await admin.auth().getUserByEmail(d.email);
      assert.equal(user.uid, r.result.uid);
      const u = await get('users/' + user.uid);
      assert.equal(u.access, 'active');
      assert.equal(u.partner, true);
      assert.equal(u.name, d.name);
      assert.equal(u.handle, '');
      assert.equal(u.profiled, false);
      assert.equal(u.points, 0);
      assert.ok(u.createdAt);
      const prof = await get(`users/${user.uid}/private/profile`);
      assert.equal(prof.email, d.email);
      assert.equal(prof.phone, '81988887777');
      const billing = await get(`users/${user.uid}/private/billing`);
      assert.equal(billing.status, 'courtesy');
      assert.equal(billing.partner, true);
      const c = await get('coupons/MARIA20');
      assert.equal(c.partnerUid, user.uid);
      assert.equal(c.partnerName, d.name);
      assert.equal(c.active, true);
      assert.equal(c.maxUses, 7);
      assert.equal(c.usedCount, 0);
      assert.ok(c.expiresAt.toMillis() > Date.now());
    });

    it('recusa anônimo e não-admin, sem criar nada', async () => {
      const d = partnerData();
      const anon = await call('createPartner', d);
      assert.equal(anon.error.status, 'UNAUTHENTICATED');
      const aluno = await call('createPartner', d, await makeUserToken(false));
      assert.equal(aluno.error.status, 'PERMISSION_DENIED');
      assert.equal((await db.collection('coupons').get()).size, 0);
      await assert.rejects(admin.auth().getUserByEmail(d.email));
    });

    it('e-mail repetido e código repetido dão erro claro e não deixam sobras', async () => {
      const token = await makeUserToken(true);
      const d = partnerData({ code: 'REPETE1' });
      assert.equal((await call('createPartner', d, token)).error, undefined);
      const dupMail = await call('createPartner', partnerData({ email: d.email }), token);
      assert.equal(dupMail.error.status, 'ALREADY_EXISTS');
      assert.equal(dupMail.error.message, 'Já existe uma conta com este e-mail.');
      const other = partnerData({ code: 'repete1' });
      const dupCode = await call('createPartner', other, token);
      assert.equal(dupCode.error.status, 'ALREADY_EXISTS');
      assert.equal(dupCode.error.message, 'Esse código já existe.');
      await assert.rejects(admin.auth().getUserByEmail(other.email));
    });

    it('valida código, limite e validade', async () => {
      const token = await makeUserToken(true);
      for (const bad of [{ code: 'abc' }, { code: 'tem espaço' }, { maxUses: 0 }, { maxUses: 501 }, { maxUses: 1.5 }, { expiresAt: '2001-01-01' }, { email: 'x' }]) {
        const r = await call('createPartner', partnerData(bad), token);
        assert.equal(r.error && r.error.status, 'INVALID_ARGUMENT', JSON.stringify(bad));
      }
    });

    it('desfaz o Auth se a gravação falhar (cupom já existente criado em corrida)', async () => {
      const token = await makeUserToken(true);
      const d = partnerData({ code: 'CORRIDA1' });
      // Simula a corrida: o cupom surge depois da checagem inicial, durante o createUser.
      const [a, b] = await Promise.all([
        call('createPartner', d, token),
        call('createPartner', partnerData({ code: 'CORRIDA1' }), token),
      ]);
      const oks = [a, b].filter((x) => !x.error);
      assert.equal(oks.length, 1);
      const losers = [a, b].filter((x) => x.error);
      assert.equal(losers[0].error.status, 'ALREADY_EXISTS');
      const users = (await db.collection('users').get()).size;
      assert.equal(users, 1);
    });
  });

  describe('signup com cupom', () => {
    it('cupom válido ativa sem checkout, sem Asaas, incrementa e grava uso; sem endereço', async () => {
      await seedCoupon('AMIGO10');
      const p = person({ coupon: ' amigo10 ' });
      const r = await call('signup', p);
      assert.equal(r.error, undefined, JSON.stringify(r.error));
      assert.deepEqual(r.result, { checkoutUrl: null, courtesy: true });
      assert.deepEqual(await checkouts(), []);
      const user = await admin.auth().getUserByEmail(p.email);
      const u = await get('users/' + user.uid);
      assert.equal(u.access, 'active');
      const billing = await get(`users/${user.uid}/private/billing`);
      assert.equal(billing.status, 'courtesy');
      assert.equal(billing.coupon, 'AMIGO10');
      assert.equal(billing.partnerUid, 'p1');
      const prof = await get(`users/${user.uid}/private/profile`);
      assert.equal(prof.address, undefined);
      assert.equal(prof.cpf, p.cpf);
      assert.equal((await get('coupons/AMIGO10')).usedCount, 1);
      const use = await get(`coupons/AMIGO10/uses/${user.uid}`);
      assert.equal(use.name, p.name);
      assert.ok(use.at);
      assert.equal((await get('cpfs/' + p.cpf)).uid, user.uid);
    });

    it('cupom com endereço informado guarda o endereço', async () => {
      await seedCoupon('AMIGO11');
      const p = person({ coupon: 'AMIGO11', address: ADDR });
      assert.equal((await call('signup', p)).error, undefined);
      const user = await admin.auth().getUserByEmail(p.email);
      assert.equal((await get(`users/${user.uid}/private/profile`)).address.city, 'Recife');
    });

    it('sem cupom, endereço ausente continua sendo erro', async () => {
      const r = await call('signup', person());
      assert.equal(r.error.status, 'INVALID_ARGUMENT');
      assert.match(r.error.message, /endereço/);
    });

    it('inexistente, inativo, vencido e esgotado dão a mesma mensagem e não deixam conta nem CPF', async () => {
      await seedCoupon('INATIVO1', { active: false });
      await seedCoupon('VENCIDO1', { expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() - 1000) });
      await seedCoupon('ESGOTAD1', { maxUses: 2, usedCount: 2 });
      for (const code of ['NAOEXIST', 'INATIVO1', 'VENCIDO1', 'ESGOTAD1']) {
        const p = person({ coupon: code });
        const r = await call('signup', p);
        assert.equal(r.error && r.error.message, MSG_COUPON, code);
        await assert.rejects(admin.auth().getUserByEmail(p.email));
        assert.equal((await db.doc('cpfs/' + p.cpf).get()).exists, false);
      }
      assert.equal((await get('coupons/ESGOTAD1')).usedCount, 2);
      assert.equal((await db.collection('users').get()).size, 0);
    });

    it('formato de cupom inválido dá a mesma mensagem', async () => {
      const r = await call('signup', person({ coupon: 'a b' }));
      assert.equal(r.error.message, MSG_COUPON);
    });

    it('dois cadastros simultâneos com maxUses 1: exatamente um vence', async () => {
      await seedCoupon('UNICO001', { maxUses: 1 });
      const [a, b] = await Promise.all([call('signup', person({ coupon: 'UNICO001' })), call('signup', person({ coupon: 'UNICO001' }))]);
      assert.equal([a, b].filter((x) => !x.error).length, 1);
      assert.equal([a, b].filter((x) => x.error && x.error.message === MSG_COUPON).length, 1);
      assert.equal((await get('coupons/UNICO001')).usedCount, 1);
      assert.equal((await db.collection('coupons/UNICO001/uses').get()).size, 1);
      assert.equal((await db.collection('users').get()).size, 1);
    });

    it('CPF repetido continua barrado e não consome o cupom', async () => {
      await seedCoupon('AMIGO20');
      const first = person({ coupon: 'AMIGO20' });
      assert.equal((await call('signup', first)).error, undefined);
      const again = person({ coupon: 'AMIGO20', cpf: first.cpf });
      const r = await call('signup', again);
      assert.equal(r.error.status, 'ALREADY_EXISTS');
      assert.equal((await get('coupons/AMIGO20')).usedCount, 1);
      assert.equal((await db.collection('coupons/AMIGO20/uses').get()).size, 1);
    });

    it('falha ao gravar a conta com cupom não consome o cupom nem deixa Auth/CPF', async () => {
      await seedCoupon('AMIGO30');
      await db.doc('testFaults/signup').set({ failBatch: true });
      const p = person({ coupon: 'AMIGO30' });
      const r = await call('signup', p);
      assert.equal(r.error.status, 'INTERNAL');
      assert.equal((await get('coupons/AMIGO30')).usedCount, 0);
      await assert.rejects(admin.auth().getUserByEmail(p.email));
      assert.equal((await db.doc('cpfs/' + p.cpf).get()).exists, false);
    });

    it('resumeCheckout recusa conta cortesia', async () => {
      await seedCoupon('AMIGO40');
      const p = person({ coupon: 'AMIGO40' });
      assert.equal((await call('signup', p)).error, undefined);
      const r = await call('resumeCheckout', {}, await signIn(p.email, p.password));
      assert.equal(r.error.status, 'FAILED_PRECONDITION');
      assert.deepEqual(await checkouts(), []);
    });
  });
});
