// Senha nova por link da Letz: pedido do aluno, link do treinador e troca com token de uso único.
// Rode com: npm run test:functions
import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

const PROJECT = 'demo-letz';
const FN = `http://127.0.0.1:5001/${PROJECT}/southamerica-east1`;
const AUTH = 'http://127.0.0.1:9099';
admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
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
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  return res.json();
}
async function mkUser(extra = {}) {
  seq += 1;
  const email = `reset${seq}-${Date.now()}@exemplo.com`;
  const u = await admin.auth().createUser({ email, password: 'senha-antiga-1' });
  if (extra.admin) await admin.auth().setCustomUserClaims(u.uid, { admin: true });
  return { uid: u.uid, email };
}
const lastMail = async () => (await db.doc('testMail/last').get()).data() || {};
const tokenOf = (text) => text.match(/#\/redefinir\/([A-Za-z0-9_-]+)/)[1];

describe('senha nova por link', () => {
  beforeEach(async () => {
    for (const c of ['users', 'passwordResets', 'rateLimits', 'testMail', 'testFaults']) await db.recursiveDelete(db.collection(c));
  });
  after(async () => { await admin.app().delete(); });

  it('aluno pede o link, recebe por e-mail e troca a senha; o link só vale uma vez', async () => {
    const u = await mkUser();
    const r = await call('requestPasswordReset', { email: u.email });
    assert.deepEqual(r.result, { ok: true });
    const mail = await lastMail();
    assert.equal(mail.to, u.email);
    const token = tokenOf(mail.text);
    const ok = await call('resetPasswordWithToken', { token, password: 'senha-nova-99' });
    assert.deepEqual(ok.result, { email: u.email });
    assert.ok((await signIn(u.email, 'senha-nova-99')).idToken);
    assert.equal((await signIn(u.email, 'senha-antiga-1')).idToken, undefined);
    const again = await call('resetPasswordWithToken', { token, password: 'outra-senha-1' });
    assert.equal(again.error.status, 'FAILED_PRECONDITION');
  });

  it('e-mail sem conta responde igual e não envia nada', async () => {
    const r = await call('requestPasswordReset', { email: 'ninguem@exemplo.com' });
    assert.deepEqual(r.result, { ok: true });
    assert.equal((await lastMail()).to, undefined);
  });

  it('segundo pedido em menos de 1 minuto não manda outro e-mail', async () => {
    const u = await mkUser();
    await call('requestPasswordReset', { email: u.email });
    await call('requestPasswordReset', { email: u.email });
    assert.equal((await lastMail()).n, 1);
  });

  it('e-mail inválido é recusado', async () => {
    const r = await call('requestPasswordReset', { email: 'abc' });
    assert.equal(r.error.status, 'INVALID_ARGUMENT');
  });

  it('link vencido e senha curta são recusados', async () => {
    const u = await mkUser();
    await call('requestPasswordReset', { email: u.email });
    const token = tokenOf((await lastMail()).text);
    assert.equal((await call('resetPasswordWithToken', { token, password: '123' })).error.status, 'INVALID_ARGUMENT');
    const snap = await db.collection('passwordResets').get();
    await snap.docs[0].ref.update({ expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() - 1000) });
    assert.equal((await call('resetPasswordWithToken', { token, password: 'senha-nova-99' })).error.status, 'FAILED_PRECONDITION');
    assert.equal((await call('resetPasswordWithToken', { token: 'x'.repeat(43), password: 'senha-nova-99' })).error.status, 'FAILED_PRECONDITION');
  });

  it('treinador gera link de 7 dias para parceiro; aluno comum não pode', async () => {
    const boss = await mkUser({ admin: true });
    const p = await mkUser();
    await db.doc('users/' + p.uid).set({ name: 'Parceiro', partner: true });
    const bossTok = (await signIn(boss.email, 'senha-antiga-1')).idToken;
    const r = await call('createAccessLink', { uid: p.uid }, bossTok);
    assert.match(r.result.resetLink, /#\/redefinir\/[A-Za-z0-9_-]{40,}$/);
    const row = (await db.collection('passwordResets').get()).docs[0].data();
    assert.ok(row.expiresAt.toMillis() - Date.now() > 6.9 * 24 * 3600e3);
    const ok = await call('resetPasswordWithToken', { token: r.result.resetLink.split('/').pop(), password: 'senha-parceiro-1' });
    assert.equal(ok.result.email, p.email);
    const stud = (await signIn(p.email, 'senha-parceiro-1')).idToken;
    assert.equal((await call('createAccessLink', { uid: p.uid }, stud)).error.status, 'PERMISSION_DENIED');
    assert.equal((await call('createAccessLink', { uid: p.uid })).error.status, 'UNAUTHENTICATED');
    assert.equal((await call('createAccessLink', { uid: boss.uid }, bossTok)).error.status, 'INVALID_ARGUMENT');
  });
});
