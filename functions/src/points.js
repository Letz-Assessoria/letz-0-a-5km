const { getFirestore } = require('firebase-admin/firestore');
const core = require('../shared/core.js');

async function getStartMs(db) {
  const snap = await db.doc('config/app').get();
  const s = snap.exists ? snap.get('start') : null;
  return s && typeof s.toMillis === 'function' ? s.toMillis() : new Date(core.DEFAULT_START_ISO).getTime();
}

// Recalcula points/done de um aluno a partir dos posts, em transação. Só grava se mudou.
async function recomputeUser(db, uid, startMs) {
  const userRef = db.doc('users/' + uid);
  await db.runTransaction(async (tx) => {
    const [user, posts] = await Promise.all([tx.get(userRef), tx.get(db.collection('posts').where('uid', '==', uid))]);
    if (!user.exists) return;
    const marks = {};
    posts.forEach((p) => {
      const d = p.data();
      if (d.at && typeof d.at.toMillis === 'function') marks[d.w + '-' + d.d] = d.at.toMillis();
    });
    const { points, done } = core.pointsFor(marks, startMs);
    if (user.get('points') !== points || user.get('done') !== done) tx.update(userRef, { points, done });
  });
}

async function onPostChange(event) {
  const before = event.data.before, after = event.data.after;
  const b = before.exists ? before.data() : null, a = after.exists ? after.data() : null;
  const atMs = (d) => (d && d.at && d.at.toMillis ? d.at.toMillis() : null);
  // Só importa criar, apagar ou mudar uid/w/d/at (rc, comentário etc. não mexem em pontos).
  if (b && a && b.uid === a.uid && b.w === a.w && b.d === a.d && atMs(b) === atMs(a)) return;
  const db = getFirestore();
  const startMs = await getStartMs(db);
  const uids = new Set([b && b.uid, a && a.uid].filter(Boolean));
  for (const uid of uids) await recomputeUser(db, uid, startMs);
}

async function onConfigChange(event) {
  const b = event.data.before.exists ? event.data.before.get('start') : null;
  const a = event.data.after.exists ? event.data.after.get('start') : null;
  const ms = (t) => (t && t.toMillis ? t.toMillis() : null);
  if (ms(b) === ms(a)) return;
  const db = getFirestore();
  const startMs = await getStartMs(db);
  const users = await db.collection('users').where('access', '==', 'active').get();
  for (const u of users.docs) await recomputeUser(db, u.id, startMs);
}

module.exports = { getStartMs, recomputeUser, onPostChange, onConfigChange };
