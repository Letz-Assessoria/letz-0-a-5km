// Testes das regras do Firestore no emulador (projeto demo-letz).
// Rode com: npm run test:rules
import { describe, it, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertSucceeds, assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp,
  collection, getDocs, setLogLevel, writeBatch,
} from 'firebase/firestore';
import { createRequire } from 'node:module';

const core = createRequire(import.meta.url)('../../public/lib/core.js');

const { WEEK_MS } = core;
const DAY = 864e5;
const FS_URL = 'https://firebasestorage.googleapis.com/v0/b/letz-0-aos-5km.firebasestorage.app/o/avatars%2Falice.jpg?alt=media';

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
    await assertSucceeds(updateDoc(ref, { name: 'Alice B', photoURL: FS_URL, profiled: true, welcomed: true }));
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

  it('users: trocar handle sem reservar handles/ é negado', async () => {
    await assertFails(updateDoc(doc(db(ALICE), 'users', ALICE), { handle: 'alicenova' }));
    // reserva de outro uid não serve
    await seed((f) => setDoc(doc(f, 'handles', 'dobob'), { uid: BOB }));
    await assertFails(updateDoc(doc(db(ALICE), 'users', ALICE), { handle: 'dobob' }));
  });

  it('handles: só aceita ids no formato [a-z0-9._]{3,30}', async () => {
    const f = db(ALICE);
    await assertFails(setDoc(doc(f, 'handles', 'AB'), { uid: ALICE }));
    await assertFails(setDoc(doc(f, 'handles', 'com espaco'), { uid: ALICE }));
    await assertFails(setDoc(doc(f, 'handles', 'x'.repeat(31)), { uid: ALICE }));
    await assertSucceeds(setDoc(doc(f, 'handles', 'alice.ok_1'.replace('_', '.')), { uid: ALICE }));
  });

  it('users: trocar handle com reserva na mesma batch é permitido', async () => {
    const f = db(ALICE);
    const b = writeBatch(f);
    b.set(doc(f, 'handles', 'alicenova'), { uid: ALICE });
    b.update(doc(f, 'users', ALICE), { handle: 'alicenova', name: 'Alice N' });
    await assertSucceeds(b.commit());
  });

  it('users: trocar handle libera o antigo na mesma batch', async () => {
    await seed((f) => setDoc(doc(f, 'handles', 'alice'), { uid: ALICE }));
    const f = db(ALICE);
    const b = writeBatch(f);
    b.set(doc(f, 'handles', 'alice.run'), { uid: ALICE });
    b.update(doc(f, 'users', ALICE), { handle: 'alice.run' });
    b.delete(doc(f, 'handles', 'alice'));
    await assertSucceeds(b.commit());
  });

  it('handles: não apaga handle ainda em uso', async () => {
    await seed((f) => setDoc(doc(f, 'handles', 'alice'), { uid: ALICE }));
    await assertFails(deleteDoc(doc(db(ALICE), 'handles', 'alice')));
  });

  it('users: rejeita name longo, handle inválido e photoURL externa', async () => {
    const ref = doc(db(ALICE), 'users', ALICE);
    await assertFails(updateDoc(ref, { name: 'x'.repeat(81) }));
    await assertFails(updateDoc(ref, { name: 42 }));
    await assertFails(updateDoc(ref, { photoURL: 'https://evil.example/pixel.gif' }));
    await assertFails(updateDoc(ref, { photoURL: 'javascript:alert(1)' }));
    await assertFails(updateDoc(ref, { photoURL: 'https://firebasestorage.googleapis.com/v0/b/outro-projeto.firebasestorage.app/o/pixel.gif' }));
    await assertFails(updateDoc(ref, { profiled: 'sim' }));
    for (const h of ['Alice', 'al', 'a'.repeat(31), 'ali ce', 'ali<b>']) {
      await seed((f) => setDoc(doc(f, 'handles', h), { uid: ALICE }));
      await assertFails(updateDoc(ref, { handle: h }));
    }
    await assertSucceeds(updateDoc(ref, { name: 'x'.repeat(80), photoURL: '' }));
    await assertFails(updateDoc(ref, { photoURL: 'http://127.0.0.1:9199/v0/b/demo-letz.appspot.com/o/a.jpg' }));
    await assertSucceeds(updateDoc(ref, { photoURL: 'https://firebasestorage.googleapis.com/v0/b/letz-0-aos-5km-dev.firebasestorage.app/o/a.jpg' }));
  });

  it('payments: aluno não lê; admin lê; ninguém escreve', async () => {
    await seed((f) => setDoc(doc(f, 'payments', 'c1'), { uid: ALICE, status: 'paid', gross: 159 }));
    await assertFails(getDoc(doc(db(ALICE), 'payments', 'c1')));
    await assertSucceeds(getDoc(doc(adminDb(), 'payments', 'c1')));
    await assertFails(setDoc(doc(adminDb(), 'payments', 'c2'), { status: 'paid' }));
    await assertFails(updateDoc(doc(adminDb(), 'payments', 'c1'), { status: 'refunded' }));
    await assertFails(deleteDoc(doc(adminDb(), 'payments', 'c1')));
    await assertFails(setDoc(doc(db(ALICE), 'payments', 'c3'), { uid: ALICE, status: 'paid' }));
  });

  it('coupons: só admin lê; admin edita só active/maxUses/expiresAt; ninguém cria nem apaga', async () => {
    await seed(async (f) => {
      await setDoc(doc(f, 'coupons', 'MARIA20'), {
        code: 'MARIA20', partnerUid: 'p1', partnerName: 'Maria', active: true, maxUses: 20, usedCount: 3,
        expiresAt: null, createdAt: Timestamp.now(),
      });
      await setDoc(doc(f, 'coupons/MARIA20/uses/u1'), { name: 'Ana', at: Timestamp.now() });
      await setDoc(doc(f, 'users', ALICE), userDoc('alice', 'active'));
    });
    const ref = (d) => doc(d, 'coupons', 'MARIA20');
    await assertFails(getDoc(ref(db(ALICE))));
    await assertFails(getDoc(ref(anonDb())));
    await assertSucceeds(getDoc(ref(adminDb())));
    await assertFails(updateDoc(ref(db(ALICE)), { active: false }));
    await assertFails(updateDoc(ref(anonDb()), { active: false }));
    await assertSucceeds(updateDoc(ref(adminDb()), { active: false }));
    await assertSucceeds(updateDoc(ref(adminDb()), { maxUses: 30 }));
    await assertSucceeds(updateDoc(ref(adminDb()), { expiresAt: Timestamp.fromMillis(Date.now() + DAY) }));
    await assertSucceeds(updateDoc(ref(adminDb()), { expiresAt: null }));
    await assertFails(updateDoc(ref(adminDb()), { usedCount: 0 }));
    await assertFails(updateDoc(ref(adminDb()), { code: 'OUTRO' }));
    await assertFails(updateDoc(ref(adminDb()), { partnerUid: 'x' }));
    await assertFails(updateDoc(ref(adminDb()), { maxUses: 0 }));
    await assertFails(updateDoc(ref(adminDb()), { maxUses: 501 }));
    await assertFails(updateDoc(ref(adminDb()), { maxUses: 2 })); // abaixo de usedCount (3)
    await assertFails(updateDoc(ref(adminDb()), { maxUses: 10.5 }));
    await assertFails(updateDoc(ref(adminDb()), { active: 'sim' }));
    await assertFails(setDoc(doc(adminDb(), 'coupons', 'NOVO0001'), { code: 'NOVO0001', active: true, maxUses: 1, usedCount: 0 }));
    await assertFails(deleteDoc(ref(adminDb())));
    const use = (d) => doc(d, 'coupons/MARIA20/uses/u1');
    await assertFails(getDoc(use(db(ALICE))));
    await assertFails(getDoc(use(anonDb())));
    await assertSucceeds(getDoc(use(adminDb())));
    await assertSucceeds(getDocs(collection(adminDb(), 'coupons/MARIA20/uses')));
    await assertFails(setDoc(doc(adminDb(), 'coupons/MARIA20/uses/u2'), { name: 'X', at: Timestamp.now() }));
    await assertFails(updateDoc(use(adminDb()), { name: 'Y' }));
    await assertFails(deleteDoc(use(adminDb())));
    await assertFails(setDoc(doc(db(ALICE), 'coupons/MARIA20/uses/alice'), { name: 'alice', at: Timestamp.now() }));
  });

  it('alerts: aluno não lê nem escreve; admin lê e só marca resolved', async () => {
    await seed((f) => setDoc(doc(f, 'alerts', 'a1'), { type: 'unknown-uid', uid: null, checkoutId: null, eventId: 'e', resolved: false }));
    await assertFails(getDoc(doc(db(ALICE), 'alerts', 'a1')));
    await assertFails(updateDoc(doc(db(ALICE), 'alerts', 'a1'), { resolved: true }));
    await assertFails(setDoc(doc(adminDb(), 'alerts', 'a2'), { resolved: false }));
    await assertFails(deleteDoc(doc(adminDb(), 'alerts', 'a1')));
    await assertSucceeds(getDoc(doc(adminDb(), 'alerts', 'a1')));
    await assertFails(updateDoc(doc(adminDb(), 'alerts', 'a1'), { type: 'x' }));
    await assertSucceeds(updateDoc(doc(adminDb(), 'alerts', 'a1'), { resolved: true }));
  });

  it('handles: não apaga handle de outro', async () => {
    await seed((f) => setDoc(doc(f, 'handles', 'bobvelho'), { uid: BOB }));
    await assertFails(deleteDoc(doc(db(ALICE), 'handles', 'bobvelho')));
    await assertFails(deleteDoc(doc(adminDb(), 'handles', 'bobvelho')));
    await assertSucceeds(deleteDoc(doc(db(BOB), 'handles', 'bobvelho')));
  });

  it('handles: cria só com uid próprio e só se não existir', async () => {
    await assertSucceeds(setDoc(doc(db(ALICE), 'handles', 'alice2'), { uid: ALICE }));
    await assertFails(setDoc(doc(db(BOB), 'handles', 'bobby'), { uid: ALICE }));
    await assertFails(setDoc(doc(db(BOB), 'handles', 'alice2'), { uid: BOB })); // já existe
    await assertFails(setDoc(doc(db(BOB), 'handles', 'bobx'), { uid: BOB, email: 'x' })); // só uid
    await assertSucceeds(getDoc(doc(db(PETE), 'handles', 'alice2'))); // checar disponibilidade
    await assertFails(deleteDoc(doc(db(BOB), 'handles', 'alice2')));
    await assertSucceeds(deleteDoc(doc(db(ALICE), 'handles', 'alice2')));
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

  it('posts: rejeita comment longo ou não string', async () => {
    const a = db(ALICE);
    await assertFails(setDoc(doc(a, 'posts', `${ALICE}_1-0`), newPost(ALICE, 1, 0, { comment: 'x'.repeat(1001) })));
    await assertFails(setDoc(doc(a, 'posts', `${ALICE}_1-0`), newPost(ALICE, 1, 0, { comment: 7 })));
    const id = await seedPost(ALICE, 1, 1);
    await assertFails(updateDoc(doc(a, 'posts', id), { comment: 'x'.repeat(1001) }));
    await assertSucceeds(updateDoc(doc(a, 'posts', id), { comment: 'x'.repeat(1000) }));
  });

  it('posts: rejeita photoPath de outro caminho', async () => {
    const a = db(ALICE);
    await assertFails(setDoc(doc(a, 'posts', `${ALICE}_1-0`), newPost(ALICE, 1, 0, { photoPath: `workouts/${BOB}/1-0.jpg` })));
    await assertFails(setDoc(doc(a, 'posts', `${ALICE}_1-0`), newPost(ALICE, 1, 0, { photoPath: `workouts/${ALICE}/1-1.jpg` })));
    await assertSucceeds(setDoc(doc(a, 'posts', `${ALICE}_1-0`), newPost(ALICE, 1, 0, { photoPath: `workouts/${ALICE}/1-0.jpg` })));
    await assertFails(updateDoc(doc(a, 'posts', `${ALICE}_1-0`), { photoPath: `avatars/${ALICE}.jpg` }));
    await assertSucceeds(updateDoc(doc(a, 'posts', `${ALICE}_1-0`), { photoPath: '' }));
  });

  it('posts: rejeita imgURL externa', async () => {
    const a = db(ALICE);
    await assertFails(setDoc(doc(a, 'posts', `${ALICE}_1-0`), newPost(ALICE, 1, 0, { imgURL: 'https://evil.example/x.jpg' })));
    await assertSucceeds(setDoc(doc(a, 'posts', `${ALICE}_1-0`), newPost(ALICE, 1, 0, { imgURL: FS_URL })));
    await assertFails(updateDoc(doc(a, 'posts', `${ALICE}_1-0`), { imgURL: 'http://evil.example/x.jpg' }));
    await assertFails(updateDoc(doc(a, 'posts', `${ALICE}_1-0`), { imgURL: 'https://firebasestorage.googleapis.com.evil.example/v0/b/x' }));
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

  it('posts: rejeita handle diferente do perfil', async () => {
    const a = db(ALICE);
    await assertFails(setDoc(doc(a, 'posts', `${ALICE}_1-0`), newPost(ALICE, 1, 0, { handle: 'bob' })));
    await assertFails(setDoc(doc(a, 'posts', `${ALICE}_1-0`), newPost(ALICE, 1, 0, { name: 'Outro Nome' })));
    await assertFails(setDoc(doc(a, 'posts', `${ALICE}_1-0`), newPost(ALICE, 1, 0, { photoURL: 'https://falsa' })));
    const { handle, ...semHandle } = newPost(ALICE, 1, 0);
    await assertFails(setDoc(doc(a, 'posts', `${ALICE}_1-0`), semHandle));
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
    await assertSucceeds(updateDoc(ref, { comment: 'Bom treino', photoPath: `workouts/${ALICE}/1-0.jpg`, imgURL: FS_URL }));
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

  it('comments: rejeita handle diferente do perfil', async () => {
    const id = await seedPost(ALICE, 1, 0);
    const c = { uid: BOB, handle: ALICE, text: 'Boa!', at: serverTimestamp(), hidden: false };
    await assertFails(setDoc(doc(db(BOB), `posts/${id}/comments/c1`), c));
    await assertSucceeds(setDoc(doc(db(BOB), `posts/${id}/comments/c1`), { ...c, handle: BOB }));
  });

  it('comments: rejeita text vazio, longo ou não string', async () => {
    const id = await seedPost(ALICE, 1, 0);
    const c = { uid: BOB, handle: BOB, text: 'Boa!', at: serverTimestamp(), hidden: false };
    for (const text of ['', 'x'.repeat(1001), 123]) {
      await assertFails(setDoc(doc(db(BOB), `posts/${id}/comments/c1`), { ...c, text }));
    }
    await assertSucceeds(setDoc(doc(db(BOB), `posts/${id}/comments/c1`), { ...c, text: 'x'.repeat(1000) }));
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
