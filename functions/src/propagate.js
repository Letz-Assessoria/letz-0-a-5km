const { getFirestore } = require('firebase-admin/firestore');

const MAX_BATCH = 500;

// Aplica `data` a todos os posts do uid, em batches de até 500 operações.
async function updatePostsOf(db, uid, data) {
  const posts = await db.collection('posts').where('uid', '==', uid).get();
  for (let i = 0; i < posts.docs.length; i += MAX_BATCH) {
    const batch = db.batch();
    posts.docs.slice(i, i + MAX_BATCH).forEach((p) => batch.update(p.ref, data));
    await batch.commit();
  }
}

// Escreve só em posts, nunca em users (evita laço com onPostWritten).
async function onUserChange(event) {
  const after = event.data.after;
  if (!after.exists) return;
  const b = event.data.before.exists ? event.data.before.data() : {};
  const a = after.data();
  const data = {};
  if (b.access !== a.access) data.authorActive = a.access === 'active';
  for (const k of ['name', 'handle', 'photoURL']) if (b[k] !== a[k] && a[k] !== undefined) data[k] = a[k];
  if (!Object.keys(data).length) return;
  await updatePostsOf(getFirestore(), event.params.uid, data);
}

module.exports = { updatePostsOf, onUserChange };
