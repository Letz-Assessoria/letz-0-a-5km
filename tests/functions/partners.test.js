// createPartner e resgate de cupom no signup (emulador Auth + Firestore + Functions).
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
const MSG_COUPON = 'Cupom inválido ou esgotado.';
const events = JSON.parse(readFileSync(new URL('./fixtures/asaas-events.json', import.meta.url), 'utf8'));
const WEBHOOK_TOKEN = readFileSync(new URL('../../functions/.secret.local', import.meta.url), 'utf8')
  .split('\n').find((l) => l.startsWith('ASAAS_WEBHOOK_TOKEN=')).split('=')[1].trim();
const hook = (body) => fetch(`${FN}/asaasWebhook`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'asaas-access-token': WEBHOOK_TOKEN }, body: JSON.stringify(body),
});
function checkoutPaid(uid, checkoutId, id = 'evt_' + Math.random()) {
  const e = structuredClone(events.checkoutPaidPix);
  e.id = id; e.checkout.id = checkoutId; e.checkout.externalReference = uid;
  return e;
}
function cardRefund(checkoutId) {
  const e = structuredClone(events.cardRefunded);
  e.id = 'evt_' + Math.random(); e.payment.checkoutSession = checkoutId;
  return e;
}

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

const ADDR = { cep: '50050-000', street: 'Rua da Aurora', number: '100', complement: '', district: 'Boa Vista', city: 'Recife', uf: 'PE' };
function person(extra = {}) {
  seq += 1;
  return {
    name: 'Aluna Cupom ' + seq, email: `cupom${seq}-${Date.now()}@exemplo.com`, password: 'senha-forte-123',
    cpf: makeCpf(), phone: '(81) 99999-0000', acceptPolicy: true, address: ADDR, ...extra,
  };
}

function partnerData(extra = {}) {
  seq += 1;
  return { name: 'Parceiro ' + seq, email: `parceiro${seq}-${Date.now()}@exemplo.com`, phone: '(81) 98888-7777', code: 'PARC' + seq + 'X', maxUses: 20, ...extra };
}

async function seedCoupon(code, extra = {}) {
  await db.doc('coupons/' + code).set({
    code, partnerUid: 'p1', partnerName: 'Parceiro', active: true, percent: 5, maxUses: 5, usedCount: 0, convertedCount: 0, expiresAt: null,
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
      assert.match(r.result.resetLink, /#\/redefinir\/[A-Za-z0-9_-]{40,}$/);
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
      assert.equal(c.percent, 5);
      assert.equal(c.usedCount, 0);
      assert.equal(c.convertedCount, 0);
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

    it('createCoupon: admin cria outro cupom para o mesmo parceiro; validações e permissões', async () => {
      const token = await makeUserToken(true);
      const pr = await call('createPartner', partnerData({ code: 'BASE0001' }), token);
      const uid = pr.result.uid;
      const r = await call('createCoupon', { partnerUid: uid, code: 'segundo2', maxUses: 5000 }, token);
      assert.equal(r.error, undefined, JSON.stringify(r.error));
      const c = await get('coupons/SEGUNDO2');
      assert.equal(c.partnerUid, uid);
      assert.equal(c.maxUses, 5000);
      assert.equal(c.usedCount, 0);
      assert.equal((await db.collection('users').get()).size, 1);
      // padrão de 100 usos
      assert.equal((await call('createCoupon', { partnerUid: uid, code: 'TERCEIRO' }, token)).error, undefined);
      assert.equal((await get('coupons/TERCEIRO')).maxUses, 1000);
      assert.equal((await get('coupons/TERCEIRO')).percent, 5);
      assert.equal((await call('createCoupon', { partnerUid: uid, code: 'SEMLIM01', maxUses: null, percent: 10 }, token)).error, undefined);
      assert.equal((await get('coupons/SEMLIM01')).maxUses, null);
      assert.equal((await get('coupons/SEMLIM01')).percent, 10);
      assert.equal((await call('createCoupon', { partnerUid: uid, code: 'SEGUNDO2' }, token)).error.status, 'ALREADY_EXISTS');
      assert.equal((await call('createCoupon', { partnerUid: 'naoexiste', code: 'QUARTO01' }, token)).error.status, 'INVALID_ARGUMENT');
      assert.equal((await call('createCoupon', { partnerUid: uid, code: 'QUARTO01', maxUses: 5001 }, token)).error.status, 'INVALID_ARGUMENT');
      assert.equal((await call('createCoupon', { partnerUid: uid, code: 'QUARTO01', percent: 51 }, token)).error.status, 'INVALID_ARGUMENT');
      assert.equal((await call('createCoupon', { partnerUid: uid, code: 'QUARTO01' }, await makeUserToken(false))).error.status, 'PERMISSION_DENIED');
      assert.equal((await call('createCoupon', { partnerUid: uid, code: 'QUARTO01' })).error.status, 'UNAUTHENTICATED');
      const p = person({ coupon: 'SEGUNDO2' });
      assert.equal((await call('signup', p)).error, undefined);
      const u = await admin.auth().getUserByEmail(p.email);
      assert.equal((await get(`coupons/SEGUNDO2/uses/${u.uid}`)).partnerUid, uid);
    });

    it('valida código, limite e validade', async () => {
      const token = await makeUserToken(true);
      for (const bad of [{ code: 'abc' }, { code: 'tem espaço' }, { maxUses: 0 }, { maxUses: 5001 }, { percent: 0 }, { percent: 51 }, { percent: 2.5 }, { maxUses: 1.5 }, { expiresAt: '2001-01-01' }, { email: 'x' }]) {
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

  describe('signup com cupom de desconto', () => {
    const sent = async () => checkouts();
    async function signupCoupon(code, extra = {}) {
      const p = person({ coupon: code, ...extra });
      const r = await call('signup', p);
      assert.equal(r.error, undefined, JSON.stringify(r.error));
      const user = await admin.auth().getUserByEmail(p.email);
      const billing = await get(`users/${user.uid}/private/billing`);
      return { p, uid: user.uid, billing, url: r.result.checkoutUrl };
    }

    it('cupom válido abre checkout com desconto e registra o cadastro (signed-up)', async () => {
      await seedCoupon('AMIGO10');
      const { p, uid, billing, url } = await signupCoupon(' amigo10 ');
      assert.match(url, /^http:\/\/127\.0\.0\.1:7777\/checkoutSession\/show\//);
      const list = await sent();
      assert.equal(list.length, 1);
      assert.equal(list[0].items[0].value, 151.05);
      assert.equal(list[0].installment.maxInstallmentCount, 12);
      assert.equal((await get('users/' + uid)).access, 'pending');
      assert.equal(billing.status, 'pending');
      assert.equal(billing.coupon, 'AMIGO10');
      assert.equal(billing.percent, 5);
      assert.equal(billing.value, 151.05);
      const co = await get('checkouts/' + billing.checkoutId);
      assert.deepEqual([co.coupon, co.percent, co.value], ['AMIGO10', 5, 151.05]);
      const c = await get('coupons/AMIGO10');
      assert.equal(c.usedCount, 1);
      assert.equal(c.convertedCount, 0);
      const use = await get(`coupons/AMIGO10/uses/${uid}`);
      assert.equal(use.status, 'signed-up');
      assert.equal(use.name, p.name);
      assert.equal(use.partnerUid, 'p1');
      assert.ok(use.at);
    });

    it('percentual configurável: 10% dá 143.10', async () => {
      await seedCoupon('DEZ10000', { percent: 10 });
      const { billing } = await signupCoupon('DEZ10000');
      assert.equal(billing.value, 143.1);
      assert.equal((await sent())[0].items[0].value, 143.1);
    });

    it('sem cupom o valor continua 159 e o endereço continua obrigatório', async () => {
      const ok = await call('signup', person());
      assert.equal(ok.error, undefined);
      assert.equal((await sent())[0].items[0].value, 159);
      const r = await call('signup', person({ address: undefined }));
      assert.equal(r.error.status, 'INVALID_ARGUMENT');
      const r2 = await call('signup', person({ address: undefined, coupon: 'AMIGO10' }));
      assert.equal(r2.error.status, 'INVALID_ARGUMENT');
      assert.match(r2.error.message, /endereço/);
    });

    it('inexistente, inativo, vencido e esgotado dão a mesma mensagem e nada é criado', async () => {
      await seedCoupon('INATIVO1', { active: false });
      await seedCoupon('VENCIDO1', { expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() - 1000) });
      await seedCoupon('ESGOTAD1', { maxUses: 2, usedCount: 2 });
      for (const code of ['NAOEXIST', 'INATIVO1', 'VENCIDO1', 'ESGOTAD1', 'a b']) {
        const p = person({ coupon: code });
        const r = await call('signup', p);
        assert.equal(r.error && r.error.message, MSG_COUPON, code);
        await assert.rejects(admin.auth().getUserByEmail(p.email));
        assert.equal((await db.doc('cpfs/' + p.cpf).get()).exists, false);
      }
      assert.equal((await get('coupons/ESGOTAD1')).usedCount, 2);
      assert.equal((await db.collection('users').get()).size, 0);
      assert.deepEqual(await sent(), []);
    });

    it('cupom sem limite (maxUses null) não esgota', async () => {
      await seedCoupon('SEMLIM01', { maxUses: null, usedCount: 9999 });
      await signupCoupon('SEMLIM01');
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
      const { p } = await signupCoupon('AMIGO20');
      const r = await call('signup', person({ coupon: 'AMIGO20', cpf: p.cpf }));
      assert.equal(r.error.status, 'ALREADY_EXISTS');
      assert.equal((await get('coupons/AMIGO20')).usedCount, 1);
      assert.equal((await db.collection('coupons/AMIGO20/uses').get()).size, 1);
    });

    it('falha ao gravar a conta não consome o cupom nem deixa Auth/CPF', async () => {
      await seedCoupon('AMIGO30');
      await db.doc('testFaults/signup').set({ failBatch: true });
      const p = person({ coupon: 'AMIGO30' });
      assert.equal((await call('signup', p)).error.status, 'INTERNAL');
      assert.equal((await get('coupons/AMIGO30')).usedCount, 0);
      await assert.rejects(admin.auth().getUserByEmail(p.email));
      assert.equal((await db.doc('cpfs/' + p.cpf).get()).exists, false);
    });

    it('resumeCheckout reabre com o mesmo valor, mesmo com o cupom desativado depois', async () => {
      await seedCoupon('AMIGO40', { percent: 10 });
      const { p, uid, billing } = await signupCoupon('AMIGO40');
      await db.doc('coupons/AMIGO40').update({ active: false, percent: 50 });
      // força a reabertura: checkout salvo vencido
      await db.doc(`users/${uid}/private/billing`).update({ expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() - 1000) });
      const r = await call('resumeCheckout', {}, await signIn(p.email, p.password));
      assert.equal(r.error, undefined, JSON.stringify(r.error));
      const list = await sent();
      assert.equal(list.length, 2);
      assert.equal(list[1].items[0].value, 143.1);
      const after = await get(`users/${uid}/private/billing`);
      assert.equal(after.value, 143.1);
      assert.notEqual(after.checkoutId, billing.checkoutId);
      assert.equal((await get('checkouts/' + after.checkoutId)).coupon, 'AMIGO40');
    });

    it('webhook: pago converte uma vez só, grava payments com desconto e cupom; refund marca refunded', async () => {
      await seedCoupon('AMIGO50');
      const { uid, billing } = await signupCoupon('AMIGO50');
      const ev = checkoutPaid(uid, billing.checkoutId);
      assert.equal((await hook(ev)).status, 200);
      assert.equal((await hook(ev)).status, 200); // repetido (mesmo id)
      assert.equal((await hook(checkoutPaid(uid, billing.checkoutId))).status, 200); // outro id, mesmo checkout
      const use = await get(`coupons/AMIGO50/uses/${uid}`);
      assert.equal(use.status, 'converted');
      assert.ok(use.convertedAt);
      assert.equal(use.value, 151.05);
      assert.equal((await get('coupons/AMIGO50')).convertedCount, 1);
      assert.equal((await get('users/' + uid)).access, 'active');
      const pay = await get('payments/' + billing.checkoutId);
      assert.equal(pay.gross, 151.05);
      assert.equal(pay.coupon, 'AMIGO50');
      assert.equal(pay.percent, 5);
      assert.equal((await hook(cardRefund(billing.checkoutId))).status, 200);
      const use2 = await get(`coupons/AMIGO50/uses/${uid}`);
      assert.equal(use2.status, 'refunded');
      assert.equal((await get('coupons/AMIGO50')).convertedCount, 0);
      assert.equal((await get('users/' + uid)).access, 'blocked');
    });

    it('webhook: compra sem cupom não mexe em cupons', async () => {
      await seedCoupon('AMIGO60');
      const p = person();
      assert.equal((await call('signup', p)).error, undefined);
      const user = await admin.auth().getUserByEmail(p.email);
      const b = await get(`users/${user.uid}/private/billing`);
      assert.equal((await hook(checkoutPaid(user.uid, b.checkoutId))).status, 200);
      assert.equal((await get('coupons/AMIGO60')).convertedCount, 0);
      assert.equal((await get('payments/' + b.checkoutId)).gross, 159);
      assert.equal((await get('payments/' + b.checkoutId)).coupon, undefined);
    });
  });
  describe('renameCoupon e deleteCoupon', () => {
    it('renomear leva usos, billing e checkout para o código novo e apaga o antigo', async () => {
      const token = await makeUserToken(true);
      const pr = await call('createPartner', partnerData({ code: 'ANTIGO01' }), token);
      const p = person({ coupon: 'ANTIGO01' });
      assert.equal((await call('signup', p)).error, undefined);
      const u = await admin.auth().getUserByEmail(p.email);
      const bill = await get(`users/${u.uid}/private/billing`);
      assert.equal(bill.coupon, 'ANTIGO01');
      const r = await call('renameCoupon', { code: 'antigo01', newCode: 'novo0002' }, token);
      assert.equal(r.error, undefined, JSON.stringify(r.error));
      assert.equal((await db.doc('coupons/ANTIGO01').get()).exists, false);
      const c = await get('coupons/NOVO0002');
      assert.equal(c.code, 'NOVO0002');
      assert.equal(c.partnerUid, pr.result.uid);
      assert.equal(c.usedCount, 1);
      assert.equal((await get(`coupons/NOVO0002/uses/${u.uid}`)).partnerUid, pr.result.uid);
      assert.equal((await db.doc(`coupons/ANTIGO01/uses/${u.uid}`).get()).exists, false);
      assert.equal((await get(`users/${u.uid}/private/billing`)).coupon, 'NOVO0002');
      const cks = (await db.collection('checkouts').where('coupon', '==', 'NOVO0002').get()).size;
      assert.equal(cks, 1);
      assert.equal((await db.collection('checkouts').where('coupon', '==', 'ANTIGO01').get()).size, 0);
    });

    it('renomear recusa código existente, inválido, inexistente e quem não é treinador', async () => {
      const token = await makeUserToken(true);
      await call('createPartner', partnerData({ code: 'UM000001' }), token);
      await call('createPartner', partnerData({ code: 'DOIS0002' }), token);
      assert.equal((await call('renameCoupon', { code: 'UM000001', newCode: 'DOIS0002' }, token)).error.status, 'ALREADY_EXISTS');
      assert.equal((await call('renameCoupon', { code: 'UM000001', newCode: 'ab' }, token)).error.status, 'INVALID_ARGUMENT');
      assert.equal((await call('renameCoupon', { code: 'NAOEXISTE', newCode: 'OUTRO003' }, token)).error.status, 'NOT_FOUND');
      assert.equal((await call('renameCoupon', { code: 'UM000001', newCode: 'OUTRO003' }, await makeUserToken(false))).error.status, 'PERMISSION_DENIED');
      assert.equal((await db.doc('coupons/UM000001').get()).exists, true);
    });

    it('excluir apaga cupom sem uso; com cadastro recusa; só treinador', async () => {
      const token = await makeUserToken(true);
      const lv = await call('createPartner', partnerData({ code: 'LIVRE001' }), token);
      await call('createPartner', partnerData({ code: 'USADO001' }), token);
      assert.equal((await call('deleteCoupon', { code: 'LIVRE001' }, token)).error.status, 'FAILED_PRECONDITION'); // único do parceiro
      assert.equal((await call('createCoupon', { partnerUid: lv.result.uid, code: 'EXTRA001' }, token)).error, undefined);
      assert.equal((await call('signup', person({ coupon: 'USADO001' }))).error, undefined);
      assert.equal((await call('deleteCoupon', { code: 'LIVRE001' }, await makeUserToken(false))).error.status, 'PERMISSION_DENIED');
      assert.equal((await call('deleteCoupon', { code: 'USADO001' }, token)).error.status, 'FAILED_PRECONDITION');
      assert.equal((await db.doc('coupons/USADO001').get()).exists, true);
      assert.equal((await call('deleteCoupon', { code: 'LIVRE001' }, token)).error, undefined);
      assert.equal((await db.doc('coupons/LIVRE001').get()).exists, false);
      assert.equal((await call('deleteCoupon', { code: 'LIVRE001' }, token)).error.status, 'NOT_FOUND');
    });
  });
});
