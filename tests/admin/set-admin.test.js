import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const PROJECT = 'demo-letz';
process.env.GCLOUD_PROJECT = PROJECT;
if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error('Rode via npm run test:admin (precisa do emulador do Auth)');
}
const auth = getAuth(getApps()[0] || initializeApp({ projectId: PROJECT }));

function run(args) {
  return execFileSync('node', ['scripts/set-admin.mjs', ...args], {
    env: process.env,
    encoding: 'utf8',
  });
}

test('set-admin: define claim no emulador do Auth', async () => {
  const email = `coach-${Date.now()}@example.test`;
  const user = await auth.createUser({ email, password: 'senha-teste-123' });
  const out = run(['--project', PROJECT, '--email', email]);
  assert.match(out, new RegExp(user.uid));
  assert.equal((await auth.getUser(user.uid)).customClaims?.admin, true);
  run(['--project', PROJECT, '--email', email, '--remove']);
  assert.equal((await auth.getUser(user.uid)).customClaims?.admin, undefined);
});

test('set-admin: cria usuário ausente e imprime link de redefinição', async () => {
  const email = `novo-${Date.now()}@example.test`;
  const out = run(['--project', PROJECT, '--email', email]);
  const user = await auth.getUserByEmail(email);
  assert.equal(user.customClaims?.admin, true);
  assert.match(out, /https?:\/\/\S+/);
});

test('set-admin: --remove não cria usuário ausente', async () => {
  const email = `ausente-${Date.now()}@example.test`;
  assert.throws(() => run(['--project', PROJECT, '--email', email, '--remove']));
  await assert.rejects(auth.getUserByEmail(email), { code: 'auth/user-not-found' });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tvat = (u) => new Date(u.tokensValidAfterTime).getTime();

async function signIn(email, password) {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const r = await fetch(
    `http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`,
    { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }) });
  return r.ok;
}

test('set-admin: conta existente não verificada é resetada antes de virar treinador', async () => {
  const email = `preso-${Date.now()}@example.test`;
  const old = 'senha-do-atacante-1';
  const user = await auth.createUser({ email, password: old, emailVerified: false });
  assert.equal(await signIn(email, old), true);
  await sleep(1100);
  const out = run(['--project', PROJECT, '--email', email]);
  const after = await auth.getUser(user.uid);
  assert.equal(after.customClaims?.admin, true);
  assert.equal(await signIn(email, old), false);
  assert.ok(tvat(after) > tvat(user));
  assert.match(out, /https?:\/\/\S+/);
});

test('set-admin: usuário verificado recebe a claim sem reset', async () => {
  const email = `ok-${Date.now()}@example.test`;
  const pw = 'senha-legitima-1';
  const user = await auth.createUser({ email, password: pw, emailVerified: true });
  const out = run(['--project', PROJECT, '--email', email]);
  assert.equal((await auth.getUser(user.uid)).customClaims?.admin, true);
  assert.equal(await signIn(email, pw), true);
  assert.doesNotMatch(out, /https?:\/\//);
});

test('set-admin: --remove revoga tokens', async () => {
  const email = `rev-${Date.now()}@example.test`;
  const user = await auth.createUser({ email, password: 'senha-teste-123', emailVerified: true });
  await auth.setCustomUserClaims(user.uid, { admin: true });
  const before = await auth.getUser(user.uid);
  await sleep(1100);
  const out = run(['--project', PROJECT, '--email', email, '--remove']);
  const after = await auth.getUser(user.uid);
  assert.equal(after.customClaims?.admin, undefined);
  assert.ok(tvat(after) > tvat(before));
  assert.match(out, /1h/);
});
