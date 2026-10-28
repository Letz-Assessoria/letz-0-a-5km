// Testes das Functions de dados no emulador (Firestore + Functions, projeto demo-letz).
// Rode com: npm run test:functions
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const admin = require('firebase-admin');
const core = require('./shared/core.js');

admin.initializeApp({ projectId: 'demo-letz' });
const db = admin.firestore();
const { Timestamp } = admin.firestore;

const START = new Date(core.DEFAULT_START_ISO).getTime();
const HOUR = 36e5;

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('timeout esperando condição; último: ' + JSON.stringify(last && last.message || last));
}

async function wipe() {
  await db.recursiveDelete(db.collection('posts'));
  await db.recursiveDelete(db.collection('users'));
  await db.recursiveDelete(db.collection('config'));
}

const mkUser = (uid, extra = {}) => db.doc('users/' + uid).set({
  name: 'Nome ' + uid, handle: uid, photoURL: '', profiled: true, welcomed: true,
  access: 'active', points: 0, done: 0, ...extra,
});
const mkPost = (uid, w, d, atMs, extra = {}) => db.doc(`posts/${uid}_${w}-${d}`).set({
  uid, w, d, at: Timestamp.fromMillis(atMs), handle: uid, name: 'Nome ' + uid, photoURL: '',
  hidden: false, authorActive: true, rc: {}, ...extra,
});
const userIs = (uid, pts, done) => async () => {
  const u = (await db.doc('users/' + uid).get()).data();
  return u && u.points === pts && u.done === done ? u : null;
};

describe('functions de dados', () => {
  beforeEach(async () => {
    await wipe();
    await db.doc('config/app').set({ start: Timestamp.fromMillis(START) });
    await new Promise((r) => setTimeout(r, 500));
  });
  after(async () => { await wipe(); await admin.app().delete(); });

  it('points: criar 4 posts na semana 1 dá points 9 done 4', async () => {
    await mkUser('ana');
    for (let d = 0; d < 3; d++) await mkPost('ana', 1, d, START + (d + 1) * HOUR);
    await mkPost('ana', 1, 3, START + 4 * HOUR);
    await waitFor(userIs('ana', 9, 4));
  });

  it('points: apagar um post recalcula', async () => {
    await mkUser('ana');
    for (let d = 0; d < 3; d++) await mkPost('ana', 1, d, START + (d + 1) * HOUR);
    await waitFor(userIs('ana', 9, 3));
    await db.doc('posts/ana_1-2').delete();
    await waitFor(userIs('ana', 6, 2));
  });

  it('reactions: duas reações fire de alunos diferentes dão rc.fire 2; remover dá 1', async () => {
    await mkUser('ana');
    await mkPost('ana', 1, 0, START + HOUR);
    await db.doc('posts/ana_1-0/reactions/bob').set({ fire: true });
    await db.doc('posts/ana_1-0/reactions/cia').set({ fire: true, clap: true });
    await waitFor(async () => (await db.doc('posts/ana_1-0').get()).data().rc?.fire === 2);
    await db.doc('posts/ana_1-0/reactions/bob').delete();
    await waitFor(async () => {
      const rc = (await db.doc('posts/ana_1-0').get()).data().rc;
      return rc?.fire === 1 && rc.clap === 1;
    });
  });

  it('reactions: 5 reações simultâneas resultam em rc correto', async () => {
    await mkUser('ana');
    await mkPost('ana', 1, 0, START + HOUR);
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map((u) => db.doc('posts/ana_1-0/reactions/' + u).set({ fire: true })));
    await waitFor(async () => (await db.doc('posts/ana_1-0').get()).data().rc?.fire === 5);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await db.doc('posts/ana_1-0').get()).data().rc.fire, 5);
  });

  it('reactions: reação em post inexistente não quebra nada', async () => {
    await db.doc('posts/fantasma_1-0/reactions/bob').set({ fire: true });
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal((await db.doc('posts/fantasma_1-0').get()).exists, false);
    // o sistema segue vivo
    await mkUser('ana');
    await mkPost('ana', 1, 0, START + HOUR);
    await waitFor(userIs('ana', 3, 1));
  });

  it('access: bloquear e reativar propaga authorActive', async () => {
    await mkUser('ana');
    await mkPost('ana', 1, 0, START + HOUR);
    await mkPost('ana', 1, 1, START + 2 * HOUR);
    await waitFor(userIs('ana', 6, 2));
    await db.doc('users/ana').update({ access: 'blocked' });
    await waitFor(async () => {
      const s = await db.collection('posts').where('uid', '==', 'ana').get();
      return s.size === 2 && s.docs.every((p) => p.data().authorActive === false);
    });
    await db.doc('users/ana').update({ access: 'active' });
    await waitFor(async () => {
      const s = await db.collection('posts').where('uid', '==', 'ana').get();
      return s.size === 2 && s.docs.every((p) => p.data().authorActive === true);
    });
  });

  it('perfil: trocar handle atualiza posts', async () => {
    await mkUser('ana');
    await mkPost('ana', 1, 0, START + HOUR);
    await waitFor(userIs('ana', 3, 1));
    await db.doc('users/ana').update({ handle: 'ana.nova', name: 'Ana Nova', photoURL: 'https://x/y.jpg' });
    await waitFor(async () => {
      const p = (await db.doc('posts/ana_1-0').get()).data();
      return p.handle === 'ana.nova' && p.name === 'Ana Nova' && p.photoURL === 'https://x/y.jpg';
    });
  });

  it('config: mudar start recalcula pontos', async () => {
    await mkUser('ana');
    await mkUser('pat', { access: 'pending' });
    // 4 posts em dias diferentes de semanas distintas: 2 na semana 0 e 2 na semana 1 -> 4 pontuam
    await mkPost('ana', 1, 0, START + HOUR);
    await mkPost('ana', 1, 1, START + 2 * HOUR);
    await mkPost('ana', 2, 0, START + 7 * 24 * HOUR + HOUR);
    await mkPost('ana', 2, 1, START + 7 * 24 * HOUR + 2 * HOUR);
    await waitFor(userIs('ana', 12, 4));
    // start passa a ser 1 ms antes da semana 2: todos os posts caem na semana 0 -> só 3 pontuam
    await db.doc('config/app').update({ start: Timestamp.fromMillis(START + 7 * 24 * HOUR - 1) });
    await waitFor(userIs('ana', 9, 4));
    const pat = (await db.doc('users/pat').get()).data();
    assert.equal(pat.points, 0);
  });
});
