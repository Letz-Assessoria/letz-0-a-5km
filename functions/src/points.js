const { getFirestore } = require('firebase-admin/firestore');
const core = require('../shared/core.js');

async function getStartMs(db) {
  const snap = await db.doc('config/app').get();
  const s = snap.exists ? snap.get('start') : null;
  return s && typeof s.toMillis === 'function' ? s.toMillis() : new Date(core.DEFAULT_START_ISO).getTime();
}

// Treinos marcados ({'w-d': ms}) a partir dos posts do aluno. O post da medalha
// (posts/{uid}_medal, medal: true, sem w/d) não é treino: não entra em pontos, done nem conclusão.
function marksFromPosts(posts) {
  const marks = {};
  posts.forEach((p) => {
    const d = p.data();
    if (d.medal === true) return;
    if (d.at && typeof d.at.toMillis === 'function') marks[d.w + '-' + d.d] = d.at.toMillis();
  });
  return marks;
}

// Pedido da medalha que já foi pago: a conclusão que o motivou não pode mais ser desfeita.
const MEDAL_PAID = ['paid', 'shipped', 'delivered'];

// Recalcula points/done de um aluno a partir dos posts, em transação. Só grava se mudou.
async function recomputeUser(db, uid, startMs) {
  const userRef = db.doc('users/' + uid);
  await db.runTransaction(async (tx) => {
    const [user, posts, medal] = await Promise.all([
      tx.get(userRef), tx.get(db.collection('posts').where('uid', '==', uid)), tx.get(db.doc(`users/${uid}/private/medal`)),
    ]);
    if (!user.exists) return;
    const marks = marksFromPosts(posts);
    const { points, done } = core.pointsFor(marks, startMs);
    // Com a medalha paga (paid/shipped/delivered) o marcador fica: é ele que mantém o pedido
    // na aba Medalhas do treinador, mesmo se o aluno desmarcar um treino depois.
    const concluded = core.isConcluded(marks) || (user.get('concluded') === true && medal.exists && MEDAL_PAID.includes(medal.get('status')));
    const upd = {};
    if (user.get('points') !== points || user.get('done') !== done) { upd.points = points; upd.done = done; }
    if ((user.get('concluded') === true) !== concluded) upd.concluded = concluded;
    if (Object.keys(upd).length) tx.update(userRef, upd);
  });
}

async function onPostChange(event) {
  const before = event.data.before, after = event.data.after;
  const b = before.exists ? before.data() : null, a = after.exists ? after.data() : null;
  const atMs = (d) => (d && d.at && d.at.toMillis ? d.at.toMillis() : null);
  // Post da medalha não mexe em pontos.
  if ((b && b.medal === true) || (a && a.medal === true)) return;
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

module.exports = { marksFromPosts, getStartMs, recomputeUser, onPostChange, onConfigChange };
