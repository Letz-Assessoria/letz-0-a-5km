// Testes das regras do Storage no emulador (projeto demo-letz).
// As regras do Storage consultam o Firestore (firestore.get) para saber se o aluno está ativo.
import { describe, it, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, setLogLevel } from 'firebase/firestore';
import { ref, uploadBytes, getBytes, deleteObject } from 'firebase/storage';

setLogLevel('silent');

let env;
const KB = 1024;
const bytes = (n) => new Uint8Array(n);
const jpeg = { contentType: 'image/jpeg' };

const st = (uid) => env.authenticatedContext(uid).storage();
const adminSt = () => env.authenticatedContext('coach', { admin: true }).storage();

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-letz',
    firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
    storage: { rules: readFileSync(new URL('../../storage.rules', import.meta.url), 'utf8') },
  });
});

after(async () => { await env?.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const f = ctx.firestore();
    await setDoc(doc(f, 'users/alice'), { name: 'alice', access: 'active' });
    await setDoc(doc(f, 'users/bob'), { name: 'bob', access: 'active' });
    await setDoc(doc(f, 'users/pete'), { name: 'pete', access: 'pending' });
    await uploadBytes(ref(ctx.storage(), 'avatars/bob.jpg'), bytes(10 * KB), jpeg);
    await uploadBytes(ref(ctx.storage(), 'workouts/bob/1-0.jpg'), bytes(10 * KB), jpeg);
  });
});

describe('storage.rules', () => {
  it('storage: dono envia avatars/{uid}.jpg image/jpeg 200 KB', async () => {
    await assertSucceeds(uploadBytes(ref(st('alice'), 'avatars/alice.jpg'), bytes(200 * KB), jpeg));
    await assertSucceeds(uploadBytes(ref(st('alice'), 'workouts/alice/1-0.jpg'), bytes(200 * KB), jpeg));
    await assertSucceeds(deleteObject(ref(st('alice'), 'workouts/alice/1-0.jpg')));
  });

  it('storage: rejeita 3 MB', async () => {
    await assertFails(uploadBytes(ref(st('alice'), 'avatars/alice.jpg'), bytes(3 * 1024 * KB), jpeg));
  });

  it('storage: rejeita content-type não imagem', async () => {
    await assertFails(uploadBytes(ref(st('alice'), 'avatars/alice.jpg'), bytes(10 * KB), { contentType: 'text/html' }));
    await assertFails(uploadBytes(ref(st('alice'), 'workouts/alice/1-0.jpg'), bytes(10 * KB), { contentType: 'application/pdf' }));
  });

  it('storage: rejeita caminho de outro uid', async () => {
    await assertFails(uploadBytes(ref(st('alice'), 'avatars/bob.jpg'), bytes(10 * KB), jpeg));
    await assertFails(uploadBytes(ref(st('alice'), 'workouts/bob/1-1.jpg'), bytes(10 * KB), jpeg));
    await assertFails(deleteObject(ref(st('alice'), 'avatars/bob.jpg')));
    await assertFails(uploadBytes(ref(st('alice'), 'workouts/alice/11-0.jpg'), bytes(10 * KB), jpeg));
    await assertFails(uploadBytes(ref(st('alice'), 'outros/alice.jpg'), bytes(10 * KB), jpeg));
  });

  it('storage: ativo lê, pendente não lê', async () => {
    await assertSucceeds(getBytes(ref(st('alice'), 'avatars/bob.jpg')));
    await assertSucceeds(getBytes(ref(st('alice'), 'workouts/bob/1-0.jpg')));
    await assertFails(getBytes(ref(st('pete'), 'avatars/bob.jpg')));
    await assertFails(getBytes(ref(st('pete'), 'workouts/bob/1-0.jpg')));
    await assertFails(getBytes(ref(env.unauthenticatedContext().storage(), 'avatars/bob.jpg')));
    await assertSucceeds(getBytes(ref(adminSt(), 'workouts/bob/1-0.jpg')));
  });
});
