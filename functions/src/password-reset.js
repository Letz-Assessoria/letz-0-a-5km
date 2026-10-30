// Senha nova por link da própria Letz (no lugar do link do Firebase, que vence em 1 h e
// morre quando o WhatsApp ou o leitor de e-mail abre a prévia). O link leva a #/redefinir/<token>;
// abrir a página não gasta nada, só o envio da senha nova usa o token (uso único, com validade).
// O token em si nunca é guardado: o documento tem o hash (SHA-256).
const crypto = require('node:crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { APP_URL } = require('./billing-config.js');
const { sendMail } = require('./mailer.js');
const { safeErr } = require('./safe.js');

const SELF_TTL_MS = 2 * 3600e3; // link pedido pelo próprio aluno
const ADMIN_TTL_MS = 7 * 24 * 3600e3; // link que o treinador manda a um parceiro
const COOLDOWN_MS = 60e3;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MSG_BAD_LINK = 'Este link venceu ou já foi usado. Peça um novo.';

const hashOf = (token) => crypto.createHash('sha256').update(token).digest('hex');
const bad = (m) => new HttpsError('invalid-argument', m);

async function issueLink(uid, email, ttlMs) {
  const token = crypto.randomBytes(32).toString('base64url');
  await getFirestore().doc('passwordResets/' + hashOf(token)).set({
    uid, email, expiresAt: Timestamp.fromMillis(Date.now() + ttlMs), createdAt: FieldValue.serverTimestamp(),
  });
  return `${APP_URL.value().replace(/\/+$/, '')}/#/redefinir/${token}`;
}

// Público. Sempre responde { ok: true }, exista a conta ou não, para não revelar quem tem cadastro.
async function requestPasswordReset(request) {
  const email = request.data && typeof request.data.email === 'string' ? request.data.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 254) throw bad('Informe um e-mail válido.');
  try {
    const user = await getAuth().getUserByEmail(email).catch((e) => {
      if (e && e.code === 'auth/user-not-found') return null;
      throw e;
    });
    if (!user || user.disabled) return { ok: true };
    const db = getFirestore();
    const cool = db.doc('rateLimits/reset_' + user.uid);
    const last = (await cool.get()).get('at');
    if (last && Date.now() - last.toMillis() < COOLDOWN_MS) return { ok: true };
    await cool.set({ at: Timestamp.now() });
    const link = await issueLink(user.uid, email, SELF_TTL_MS);
    await sendMail({
      to: email,
      subject: 'Crie uma senha nova no Do 0 aos 5 km',
      text: `Oi!\n\nPara criar uma senha nova, abra o link abaixo (vale por 2 horas e só funciona uma vez):\n\n${link}\n\nSe você não pediu, pode ignorar este e-mail. Sua senha continua a mesma.\n\nLetz Assessoria`,
    });
  } catch (err) {
    logger.error('requestPasswordReset falhou', { err: safeErr(err) });
  }
  return { ok: true };
}

// Só o treinador. Devolve um link novo (7 dias) para ele mandar ao parceiro.
async function createAccessLink(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Entre com seu e-mail e senha.');
  if (request.auth.token.admin !== true) throw new HttpsError('permission-denied', 'Só o treinador pode gerar o link.');
  const uid = request.data && request.data.uid;
  if (typeof uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw bad('Parceiro inválido.');
  const user = await getFirestore().doc('users/' + uid).get();
  if (!user.exists || user.get('partner') !== true) throw bad('Parceiro não encontrado.');
  const auth = await getAuth().getUser(uid).catch(() => null);
  if (!auth || !auth.email) throw bad('Parceiro não encontrado.');
  return { resetLink: await issueLink(uid, auth.email, ADMIN_TTL_MS) };
}

// Público. Gasta o token e troca a senha.
async function resetPasswordWithToken(request) {
  const d = request.data || {};
  const token = typeof d.token === 'string' ? d.token : '';
  const password = typeof d.password === 'string' ? d.password : '';
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new HttpsError('failed-precondition', MSG_BAD_LINK);
  if (password.length < 6 || password.length > 128) throw bad('A senha precisa ter pelo menos 6 caracteres.');
  const db = getFirestore();
  const ref = db.doc('passwordResets/' + hashOf(token));
  const row = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists || s.get('usedAt') || s.get('expiresAt').toMillis() < Date.now()) return null;
    tx.update(ref, { usedAt: FieldValue.serverTimestamp() });
    return s.data();
  });
  if (!row) throw new HttpsError('failed-precondition', MSG_BAD_LINK);
  try {
    await getAuth().updateUser(row.uid, { password });
    await getAuth().revokeRefreshTokens(row.uid);
  } catch (err) {
    logger.error('resetPasswordWithToken: não trocou a senha', { uid: row.uid, err: safeErr(err) });
    await ref.update({ usedAt: FieldValue.delete() }).catch(() => {});
    throw new HttpsError('internal', 'Não foi possível trocar a senha. Tente de novo.');
  }
  return { email: row.email };
}

module.exports = { requestPasswordReset, createAccessLink, resetPasswordWithToken, issueLink, ADMIN_TTL_MS };
