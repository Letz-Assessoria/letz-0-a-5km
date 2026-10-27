const { getFirestore } = require('firebase-admin/firestore');

const KINDS = ['oi', 'clap', 'fire', 'power', 'love'];

// Recontagem completa (idempotente). Post inexistente: não faz nada.
async function onReactionChange(event) {
  const db = getFirestore();
  const postRef = db.doc('posts/' + event.params.postId);
  const [post, reactions] = await Promise.all([postRef.get(), postRef.collection('reactions').get()]);
  if (!post.exists) return;
  const rc = {};
  reactions.forEach((r) => {
    const d = r.data();
    KINDS.forEach((k) => { if (d[k] === true) rc[k] = (rc[k] || 0) + 1; });
  });
  await postRef.update({ rc });
}

module.exports = { onReactionChange };
