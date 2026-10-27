// Testes das regras do Firestore no emulador (projeto demo-letz).
// Rode com: npm run test:rules
import { describe, it, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp,
  collection, getDocs, setLogLevel,
} from 'firebase/firestore';
import { createRequire } from 'node:module';

const core = createRequire(import.meta.url)('../../public/lib/core.js');

const { WEEK_MS } = core;
const DAY = 864e5;

setLogLevel('silent');

let env;

const ALICE = 'alice'; // ativa
const BOB = 'bob'; // ativo
const PETE = 'pete'; // pendente
const COACH = 'coach'; // treinador (claim admin), sem users/{uid}

const userDoc = (name, access) => ({
  name, handle: name, photoURL: '', profiled: true, welcomed: true,
  access, points: 0, done: 0, createdAt: Timestamp.now(),
});

const db = (uid) => env.authenticatedContext(uid).firestore();
const adminDb = () => env.authenticatedContext(COACH, { admin: true }).firestore();
const anonDb = () => env.unauthenticatedContext().firestore();

async function seed(fn) {
  await env.withSecurityRulesDisabled(async (ctx) => { await fn(ctx.firestore()); });
}

// A turma começou há 3 dias: semana 1 aberta, semana 2 trancada.
async function seedConfig(startMs = Date.now() - 3 * DAY) {
  await seed((f) => setDoc(doc(f, 'config/app'), {
    start: Timestamp.fromMillis(startMs), texts: {}, videos: [], salesOpen: true,
  }));
}

const newPost = (uid, w, d, extra = {}) => ({
  uid, handle: uid, name: uid, photoURL: '', w, d, at: serverTimestamp(),
  comment: '', photoPath: '', imgURL: '', hidden: false, authorActive: true, rc: {},
  ...extra,
});

// Post já existente, gravado sem regras.
async function seedPost(uid, w, d) {
  const id = `${uid}_${w}-${d}`;
  await seed((f) => setDoc(doc(f, 'posts', id), { ...newPost(uid, w, d), at: Timestamp.now() }));
  return id;
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-letz',
    firestore: { rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8') },
  });
});

after(async () => { await env?.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await seed(async (f) => {
    await setDoc(doc(f, 'users', ALICE), userDoc(ALICE, 'active'));
    await setDoc(doc(f, 'users', BOB), userDoc(BOB, 'active'));
    await setDoc(doc(f, 'users', PETE), userDoc(PETE, 'pending'));
  });
  await seedConfig();
});

describe('firestore.rules', () => {
  it('sanidade: WEEK_MS é 7 dias', () => {
    if (WEEK_MS !== 7 * DAY) throw new Error('WEEK_MS inesperado');
  });

  it('users: aluno não altera access, points nem done', async () => {
    const ref = doc(db(ALICE), 'users', ALICE);
    await assertSucceeds(updateDoc(ref, { name: 'Alice B', handle: 'aliceb', photoURL: 'x', profiled: true, welcomed: true }));
    await assertFails(updateDoc(ref, { access: 'blocked' }));
    await assertFails(updateDoc(ref, { points: 999 }));
    await assertFails(updateDoc(ref, { done: 30 }));
    await assertFails(updateDoc(doc(db(PETE), 'users', PETE), { access: 'active' }));
    // não cria o próprio users/{uid} (só Functions)
    await assertFails(setDoc(doc(db('novo'), 'users', 'novo'), userDoc('novo', 'pending')));
    // não altera o de outro
    await assertFails(updateDoc(doc(db(ALICE), 'users', BOB), { name: 'hack' }));
    // treinador altera access
    await assertSucceeds(updateDoc(doc(adminDb(), 'users', PETE), { access: 'active' }));
  });

  it('users: aluno ativo lê users de outro, pendente não lê', async () => {
    await assertSucceeds(getDoc(doc(db(ALICE), 'users', BOB)));
    await assertFails(getDoc(doc(db(PETE), 'users', BOB)));
    await assertSucceeds(getDoc(doc(db(PETE), 'users', PETE))); // o próprio, sim
    await assertFails(getDoc(doc(anonDb(), 'users', BOB)));
  });

  it('private: aluno não lê private de outro; treinador lê', async () => {
    await seed(async (f) => {
      await setDoc(doc(f, `users/${BOB}/private/profile`), { email: 'b@x.com', cpf: '123', phone: '9' });
      await setDoc(doc(f, `users/${BOB}/private/billing`), { status: 'paid' });
      await setDoc(doc(f, `users/${BOB}/private/ship`), { nome: 'Bob', cep: '1' });
    });
    for (const p of ['profile', 'billing', 'ship']) {
      await assertFails(getDoc(doc(db(ALICE), `users/${BOB}/private/${p}`)));
      await assertSucceeds(getDoc(doc(db(BOB), `users/${BOB}/private/${p}`)));
      await assertSucceeds(getDoc(doc(adminDb(), `users/${BOB}/private/${p}`)));
    }
  });

  it('private/profile e billing: cliente não escreve', async () => {
    await assertFails(setDoc(doc(db(ALICE), `users/${ALICE}/private/profile`), { email: 'a@x.com' }));
    await assertFails(setDoc(doc(db(ALICE), `users/${ALICE}/private/billing`), { status: 'paid' }));
    await assertFails(setDoc(doc(adminDb(), `users/${ALICE}/private/billing`), { status: 'paid' }));
    await assertFails(setDoc(doc(db(ALICE), `users/${ALICE}/private/outro`), { x: 1 }));
  });

  it('ship: aluno escreve endereço mas não paidAt/track; treinador escreve paidAt/track', async () => {
    const ref = doc(db(ALICE), `users/${ALICE}/private/ship`);
    const addr = { nome: 'Alice', cep: '50000-000', rua: 'Rua A', num: '1', comp: '', bairro: 'B', cidade: 'Recife', uf: 'PE', tel: '81999999999', at: serverTimestamp() };
    await assertSucceeds(setDoc(ref, addr));
    await assertSucceeds(updateDoc(ref, { num: '2' }));
    await assertFails(updateDoc(ref, { paidAt: serverTimestamp() }));
    await assertFails(updateDoc(ref, { track: 'BR123' }));
    await assertFails(setDoc(doc(db(BOB), `users/${ALICE}/private/ship`), addr));
    const aref = doc(adminDb(), `users/${ALICE}/private/ship`);
    await assertSucceeds(updateDoc(aref, { paidAt: serverTimestamp(), track: 'BR123' }));
    await assertFails(updateDoc(aref, { rua: 'Outra' }));
  });

  it('handles: cria só com uid próprio e só se não existir', async () => {
    await assertSucceeds(setDoc(doc(db(ALICE), 'handles', 'alice'), { uid: ALICE }));
    await assertFails(setDoc(doc(db(BOB), 'handles', 'bobby'), { uid: ALICE }));
    await assertFails(setDoc(doc(db(BOB), 'handles', 'alice'), { uid: BOB })); // já existe
    await assertFails(setDoc(doc(db(BOB), 'handles', 'bobx'), { uid: BOB, email: 'x' })); // só uid
    await assertSucceeds(getDoc(doc(db(PETE), 'handles', 'alice'))); // checar disponibilidade
    await assertFails(deleteDoc(doc(db(BOB), 'handles', 'alice')));
    await assertSucceeds(deleteDoc(doc(db(ALICE), 'handles', 'alice')));
  });

  it('cpfs: cliente não lê nem escreve', async () => {
    await seed((f) => setDoc(doc(f, 'cpfs', '12345678900'), { uid: BOB }));
    await assertFails(getDoc(doc(db(ALICE), 'cpfs', '12345678900')));
    await assertFails(getDoc(doc(adminDb(), 'cpfs', '12345678900')));
    await assertFails(setDoc(doc(db(ALICE), 'cpfs', '11111111111'), { uid: ALICE }));
  });

  it('posts: aluno ativo cria o próprio post com at == request.time', async () => {
    await assertSucceeds(setDoc(doc(db(ALICE), 'posts', `${ALICE}_1-0`), newPost(ALICE, 1, 0)));
    const { rc, ...semRc } = newPost(ALICE, 1, 1);
    await assertSucceeds(setDoc(doc(db(ALICE), 'posts', `${ALICE}_1-1`), semRc));
  });

  it('posts: rejeita at diferente de request.time', async () => {
    const p = newPost(ALICE, 1, 0, { at: Timestamp.fromMillis(Date.now() - DAY) });
    await assertFails(setDoc(doc(db(ALICE), 'posts', `${ALICE}_1-0`), p));
  });

  it('posts: rejeita semana trancada', async () => {
    // turma na semana 1: w=2 ainda trancada
    await assertFails(setDoc(doc(db(ALICE), 'posts', `${ALICE}_2-0`), newPost(ALICE, 2, 0)));
    // start no futuro: até w=1 está trancada
    await seedConfig(Date.now() + DAY);
    await assertFails(setDoc(doc(db(ALICE), 'posts', `${ALICE}_1-0`), newPost(ALICE, 1, 0)));
  });

  it('posts: pendente não cria', async () => {
    await assertFails(setDoc(doc(db(PETE), 'posts', `${PETE}_1-0`), newPost(PETE, 1, 0)));
  });

  it('posts: rejeita id que não seja {uid}_{w}-{d} coerente com os campos', async () => {
    const a = db(ALICE);
    await assertFails(setDoc(doc(a, 'posts', `${ALICE}_1-1`), newPost(ALICE, 1, 0)));
    await assertFails(setDoc(doc(a, 'posts', `${BOB}_1-0`), newPost(ALICE, 1, 0)));
    await assertFails(setDoc(doc(a, 'posts', `${BOB}_1-0`), newPost(BOB, 1, 0)));
    await assertFails(setDoc(doc(a, 'posts', 'qualquer'), newPost(ALICE, 1, 0)));
    await assertFails(setDoc(doc(a, 'posts', `${ALICE}_1-3`), newPost(ALICE, 1, 3)));
    await assertFails(setDoc(doc(a, 'posts', `${ALICE}_0-0`), newPost(ALICE, 0, 0)));
    await assertFails(setDoc(doc(a, 'posts', `${ALICE}_1-0`), newPost(ALICE, '1', 0)));
    // campos de servidor travados na criação
    await assertFails(setDoc(doc(a, 'posts', `${ALICE}_1-0`), newPost(ALICE, 1, 0, { hidden: true })));
    await assertFails(setDoc(doc(a, 'posts', `${ALICE}_1-0`), newPost(ALICE, 1, 0, { authorActive: false })));
    await assertFails(setDoc(doc(a, 'posts', `${ALICE}_1-0`), newPost(ALICE, 1, 0, { rc: { fire: 50 } })));
  });

  it('posts: aluno edita só comment/photoPath/imgURL do próprio; não muda hidden, rc, authorActive', async () => {
    const id = await seedPost(ALICE, 1, 0);
    const ref = doc(db(ALICE), 'posts', id);
    await assertSucceeds(updateDoc(ref, { comment: 'Bom treino', photoPath: `workouts/${ALICE}/1-0.jpg`, imgURL: 'https://x' }));
    await assertFails(updateDoc(ref, { hidden: true }));
    await assertFails(updateDoc(ref, { rc: { fire: 10 } }));
    await assertFails(updateDoc(ref, { authorActive: false }));
    await assertFails(updateDoc(ref, { at: serverTimestamp() }));
    await assertFails(updateDoc(doc(db(BOB), 'posts', id), { comment: 'hack' }));
    await assertFails(deleteDoc(doc(db(BOB), 'posts', id)));
    await assertSucceeds(deleteDoc(ref));
  });

  it('posts: treinador muda hidden', async () => {
    const id = await seedPost(ALICE, 1, 0);
    await assertSucceeds(updateDoc(doc(adminDb(), 'posts', id), { hidden: true }));
    await assertFails(updateDoc(doc(adminDb(), 'posts', id), { comment: 'x' }));
  });

  it('comments: autor cria e apaga; treinador muda hidden; outro aluno não apaga', async () => {
    const id = await seedPost(ALICE, 1, 0);
    const path = `posts/${id}/comments/c1`;
    const c = { uid: BOB, handle: BOB, text: 'Boa!', at: serverTimestamp(), hidden: false };
    await assertFails(setDoc(doc(db(BOB), path), { ...c, uid: ALICE }));
    await assertFails(setDoc(doc(db(PETE), `posts/${id}/comments/c2`), { ...c, uid: PETE }));
    await assertFails(setDoc(doc(db(BOB), path), { ...c, hidden: true }));
    await assertSucceeds(setDoc(doc(db(BOB), path), c));
    await assertSucceeds(getDoc(doc(db(ALICE), path)));
    await assertFails(getDoc(doc(db(PETE), path)));
    await assertFails(updateDoc(doc(db(BOB), path), { hidden: true }));
    await assertSucceeds(updateDoc(doc(adminDb(), path), { hidden: true }));
    await assertFails(deleteDoc(doc(db(ALICE), path)));
    await assertSucceeds(deleteDoc(doc(db(BOB), path)));
  });

  it('reactions: só escreve o doc com o próprio uid', async () => {
    const id = await seedPost(ALICE, 1, 0);
    await assertSucceeds(setDoc(doc(db(BOB), `posts/${id}/reactions/${BOB}`), { fire: true, clap: false }));
    await assertFails(setDoc(doc(db(BOB), `posts/${id}/reactions/${ALICE}`), { fire: true }));
    await assertFails(setDoc(doc(db(BOB), `posts/${id}/reactions/${BOB}`), { fire: 5 }));
    await assertFails(setDoc(doc(db(BOB), `posts/${id}/reactions/${BOB}`), { hack: true }));
    await assertFails(setDoc(doc(db(PETE), `posts/${id}/reactions/${PETE}`), { fire: true }));
    await assertSucceeds(getDoc(doc(db(ALICE), `posts/${id}/reactions/${BOB}`)));
    await assertSucceeds(deleteDoc(doc(db(BOB), `posts/${id}/reactions/${BOB}`)));
  });

  it('config: ativo lê, só treinador escreve', async () => {
    await assertSucceeds(getDoc(doc(db(ALICE), 'config/app')));
    await assertFails(getDoc(doc(db(PETE), 'config/app')));
    await assertFails(updateDoc(doc(db(ALICE), 'config/app'), { salesOpen: false }));
    await assertSucceeds(updateDoc(doc(adminDb(), 'config/app'), { salesOpen: false }));
  });

  it('asaasEvents: cliente sem acesso', async () => {
    await seed((f) => setDoc(doc(f, 'asaasEvents', 'evt1'), { type: 'PAYMENT_RECEIVED', uid: ALICE }));
    for (const f of [db(ALICE), adminDb()]) {
      await assertFails(getDoc(doc(f, 'asaasEvents', 'evt1')));
      await assertFails(setDoc(doc(f, 'asaasEvents', 'evt2'), { type: 'x' }));
    }
  });

  it('admin: treinador lê feed, users e private', async () => {
    const id = await seedPost(ALICE, 1, 0);
    await seed(async (f) => {
      await setDoc(doc(f, `posts/${id}/comments/c1`), { uid: BOB, handle: BOB, text: 'oi', at: Timestamp.now(), hidden: false });
      await setDoc(doc(f, `posts/${id}/reactions/${BOB}`), { fire: true });
      await setDoc(doc(f, `users/${ALICE}/private/profile`), { email: 'a@x.com' });
    });
    const a = adminDb();
    await assertSucceeds(getDocs(collection(a, 'posts')));
    await assertSucceeds(getDocs(collection(a, `posts/${id}/comments`)));
    await assertSucceeds(getDocs(collection(a, `posts/${id}/reactions`)));
    await assertSucceeds(getDocs(collection(a, 'users')));
    await assertSucceeds(getDoc(doc(a, `users/${ALICE}/private/profile`)));
    await assertSucceeds(getDoc(doc(a, 'config/app')));
    // aluno ativo lê o feed; pendente não
    await assertSucceeds(getDocs(collection(db(ALICE), 'posts')));
    await assertFails(getDocs(collection(db(PETE), 'posts')));
  });
});
