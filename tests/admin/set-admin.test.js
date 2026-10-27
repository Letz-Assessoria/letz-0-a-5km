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
