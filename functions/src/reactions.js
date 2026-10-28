const { getFirestore } = require('firebase-admin/firestore');

const KINDS = ['oi', 'clap', 'fire', 'power', 'love'];

// Recontagem completa (idempotente), dentro de transação. Post inexistente: não faz nada.
async function onReactionChange(event) {
  const db = getFirestore();
  const postRef = db.doc('posts/' + event.params.postId);
  await db.runTransaction(async (tx) => {
    const [post, reactions] = await Promise.all([tx.get(postRef), tx.get(postRef.collection('reactions'))]);
    if (!post.exists) return;
    const rc = {};
    reactions.forEach((r) => {
      const d = r.data();
      KINDS.forEach((k) => { if (d[k] === true) rc[k] = (rc[k] || 0) + 1; });
    });
    if (JSON.stringify(sorted(rc)) === JSON.stringify(sorted(post.get('rc') || {}))) return;
    tx.update(postRef, { rc });
  });
}

const sorted = (o) => Object.keys(o).sort().map((k) => [k, o[k]]);

module.exports = { onReactionChange };
