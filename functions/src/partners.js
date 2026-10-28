// createPartner: o treinador cadastra um parceiro (acesso de aluno sem pagar) e o cupom
// personalizado dele, tudo ou nada. Só admin (custom claim admin === true).
const crypto = require('node:crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const core = require('../shared/core.js');
const { safeErr } = require('./safe.js');

const COUPON_RE = /^[A-Z0-9]{4,20}$/;
const MSG_CODE_EXISTS = 'Esse código já existe.';
const MSG_EMAIL_EXISTS = 'Já existe uma conta com este e-mail.';

// apiKey web de cada projeto (pública, a mesma de public/js/fb.js); o link do Admin SDK sai com apiKey vazia.
const WEB_API_KEYS = {
  'letz-0-aos-5km': 'AIzaSyA6ohoB15NRgaLBFLRy8EacGgAAWXkXtaU',
  'letz-0-aos-5km-dev': 'AIzaSyCQ_c-OtMyMqMdKRYqt0mKEgA13-RyGPuU',
};
function withApiKey(link) {
  const key = WEB_API_KEYS[process.env.GCLOUD_PROJECT];
  return key ? link.replace(/([?&]apiKey=)(?=&|$)/, `$1${key}`) : link;
}

const bad = (m) => new HttpsError('invalid-argument', m);

function validate(data) {
  const d = data && typeof data === 'object' ? data : {};
  const name = typeof d.name === 'string' ? d.name.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2 || name.length > 80) throw bad('Informe o nome do parceiro.');
  const email = typeof d.email === 'string' ? d.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw bad('Informe um e-mail válido.');
  let phone = null;
  if (typeof d.phone === 'string' && d.phone.trim()) {
    phone = core.normalizePhone(d.phone);
    if (!phone) throw bad('Celular inválido. Use o DDD.');
  }
  const code = typeof d.code === 'string' ? d.code.trim().toUpperCase() : '';
  if (!COUPON_RE.test(code)) throw bad('O código do cupom precisa ter de 4 a 20 letras ou números.');
  const maxUses = d.maxUses === undefined || d.maxUses === null ? 20 : d.maxUses;
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 500) throw bad('O limite de usos vai de 1 a 500.');
  let expiresAt = null;
  if (d.expiresAt) {
    if (typeof d.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.expiresAt)) throw bad('Validade inválida.');
    // Vale até o fim do dia, no horário de Brasília.
    const ms = Date.parse(d.expiresAt + 'T23:59:59-03:00');
    if (Number.isNaN(ms)) throw bad('Validade inválida.');
    if (ms <= Date.now()) throw bad('A validade já passou.');
    expiresAt = Timestamp.fromMillis(ms);
  }
  return { name, email, phone, code, maxUses, expiresAt };
}

async function createPartner(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Entre com seu e-mail e senha.');
  if (request.auth.token.admin !== true) throw new HttpsError('permission-denied', 'Só o treinador pode cadastrar parceiros.');
  const { name, email, phone, code, maxUses, expiresAt } = validate(request.data);
  const db = getFirestore();
  const auth = getAuth();
  const couponRef = db.doc('coupons/' + code);

  if ((await couponRef.get()).exists) throw new HttpsError('already-exists', MSG_CODE_EXISTS);
  try {
    await auth.getUserByEmail(email);
    throw new HttpsError('already-exists', MSG_EMAIL_EXISTS);
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    if (!err || err.code !== 'auth/user-not-found') {
      logger.error('createPartner: getUserByEmail falhou', { err: safeErr(err) });
      throw new HttpsError('internal', 'Não foi possível criar o parceiro. Tente de novo.');
    }
  }

  const uid = db.collection('users').doc().id;
  try {
    await auth.createUser({ uid, email, password: crypto.randomBytes(24).toString('base64url'), displayName: name });
  } catch (err) {
    const c = (err && err.code) || '';
    if (c === 'auth/email-already-exists') throw new HttpsError('already-exists', MSG_EMAIL_EXISTS);
    logger.error('createPartner: createUser falhou', { uid, code: c, err: safeErr(err) });
    // Erro ambíguo: se a conta chegou a nascer, remove.
    await auth.deleteUser(uid).catch(() => {});
    throw new HttpsError('internal', 'Não foi possível criar o parceiro. Tente de novo.');
  }

  try {
    const now = FieldValue.serverTimestamp();
    const batch = db.batch();
    batch.create(db.doc('users/' + uid), {
      name, handle: '', photoURL: '', profiled: false, welcomed: false,
      access: 'active', partner: true, points: 0, done: 0, createdAt: now,
    });
    batch.create(db.doc(`users/${uid}/private/profile`), phone ? { email, phone } : { email });
    batch.create(db.doc(`users/${uid}/private/billing`), { status: 'courtesy', partner: true, updatedAt: now });
    batch.create(couponRef, {
      code, partnerUid: uid, partnerName: name, active: true, maxUses, usedCount: 0, expiresAt, createdAt: now,
    });
    await batch.commit();
    const resetLink = withApiKey(await auth.generatePasswordResetLink(email));
    return { uid, code, resetLink };
  } catch (err) {
    const dup = err && (err.code === 6 || err.code === 'already-exists');
    logger.error('createPartner: falhou depois de criar o usuário; desfazendo', { uid, err: safeErr(err) });
    await auth.deleteUser(uid).catch((e) => logger.error('createPartner: não removeu o usuário do Auth', { uid, err: safeErr(e) }));
    // Se o lote não chegou a gravar, nada sobra; se gravou parcialmente, limpa.
    await Promise.all([
      db.recursiveDelete(db.doc('users/' + uid)),
      couponRef.get().then((s) => (s.exists && s.get('partnerUid') === uid ? couponRef.delete() : null)),
    ]).catch(() => {});
    if (dup) throw new HttpsError('already-exists', MSG_CODE_EXISTS);
    throw new HttpsError('internal', 'Não foi possível criar o parceiro. Tente de novo.');
  }
}

module.exports = { createPartner, validate };
