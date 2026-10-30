// createPartner: o treinador cadastra um parceiro (acesso de aluno sem pagar) e o cupom
// de desconto percentual dele, tudo ou nada. Só admin (custom claim admin === true).
const crypto = require('node:crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const core = require('../shared/core.js');
const { safeErr } = require('./safe.js');
const { issueLink, ADMIN_TTL_MS } = require('./password-reset.js');

const COUPON_RE = /^[A-Z0-9]{4,20}$/;
const MSG_CODE_EXISTS = 'Esse código já existe.';
const MSG_EMAIL_EXISTS = 'Já existe uma conta com este e-mail.';

const bad = (m) => new HttpsError('invalid-argument', m);

function couponFields(d) {
  const code = typeof d.code === 'string' ? d.code.trim().toUpperCase() : '';
  if (!COUPON_RE.test(code)) throw bad('O código do cupom precisa ter de 4 a 20 letras ou números.');
  // Limite opcional: em branco (null) = sem limite; ausente = 1000.
  const maxUses = d.maxUses === undefined ? 1000 : (d.maxUses === null || d.maxUses === '' ? null : d.maxUses);
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 5000)) throw bad('O limite de usos vai de 1 a 5000.');
  const percent = d.percent === undefined || d.percent === null ? 5 : d.percent;
  if (!Number.isInteger(percent) || percent < 1 || percent > 50) throw bad('O desconto vai de 1% a 50%.');
  let expiresAt = null;
  if (d.expiresAt) {
    if (typeof d.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.expiresAt)) throw bad('Validade inválida.');
    // Vale até o fim do dia, no horário de Brasília.
    const ms = Date.parse(d.expiresAt + 'T23:59:59-03:00');
    if (Number.isNaN(ms)) throw bad('Validade inválida.');
    if (ms <= Date.now()) throw bad('A validade já passou.');
    expiresAt = Timestamp.fromMillis(ms);
  }
  return { code, maxUses, percent, expiresAt };
}

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
  return { name, email, phone, ...couponFields(d) };
}

async function createPartner(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Entre com seu e-mail e senha.');
  if (request.auth.token.admin !== true) throw new HttpsError('permission-denied', 'Só o treinador pode cadastrar parceiros.');
  const { name, email, phone, code, maxUses, percent, expiresAt } = validate(request.data);
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
      code, partnerUid: uid, partnerName: name, active: true, percent, maxUses, usedCount: 0, convertedCount: 0, expiresAt, createdAt: now,
    });
    await batch.commit();
    const resetLink = await issueLink(uid, email, ADMIN_TTL_MS);
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

// Outro cupom para um parceiro que já existe (sem criar conta).
async function createCoupon(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Entre com seu e-mail e senha.');
  if (request.auth.token.admin !== true) throw new HttpsError('permission-denied', 'Só o treinador pode criar cupons.');
  const d = request.data && typeof request.data === 'object' ? request.data : {};
  const fields = couponFields(d);
  if (typeof d.partnerUid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(d.partnerUid)) throw bad('Parceiro inválido.');
  const db = getFirestore();
  const user = await db.doc('users/' + d.partnerUid).get();
  if (!user.exists || user.get('partner') !== true) throw bad('Parceiro não encontrado.');
  try {
    await db.doc('coupons/' + fields.code).create({
      code: fields.code, partnerUid: d.partnerUid, partnerName: user.get('name'), active: true,
      percent: fields.percent, maxUses: fields.maxUses, usedCount: 0, convertedCount: 0, expiresAt: fields.expiresAt, createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    if (err && (err.code === 6 || err.code === 'already-exists')) throw new HttpsError('already-exists', MSG_CODE_EXISTS);
    logger.error('createCoupon: falhou', { err: safeErr(err) });
    throw new HttpsError('internal', 'Não foi possível criar o cupom. Tente de novo.');
  }
  return { code: fields.code };
}

function adminOnly(request, what) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Entre com seu e-mail e senha.');
  if (request.auth.token.admin !== true) throw new HttpsError('permission-denied', `Só o treinador pode ${what}.`);
}
function codeArg(v, label) {
  const code = typeof v === 'string' ? v.trim().toUpperCase() : '';
  if (!COUPON_RE.test(code)) throw bad(label);
  return code;
}

// Troca o código do cupom (ele é o id do documento): cria o novo com os mesmos dados e usos,
// aponta para o novo código quem já se cadastrou (billing, checkouts, payments) e só então apaga o antigo.
async function renameCoupon(request) {
  adminOnly(request, 'renomear cupons');
  const old = codeArg(request.data && request.data.code, 'Cupom inválido.');
  const next = codeArg(request.data && request.data.newCode, 'O código do cupom precisa ter de 4 a 20 letras ou números.');
  if (old === next) return { code: next };
  const db = getFirestore();
  const oldRef = db.doc('coupons/' + old);
  const oldSnap = await oldRef.get();
  if (!oldSnap.exists) throw new HttpsError('not-found', 'Cupom não encontrado.');
  const newRef = db.doc('coupons/' + next);
  try {
    await newRef.create({ ...oldSnap.data(), code: next });
  } catch (err) {
    if (err && (err.code === 6 || err.code === 'already-exists')) throw new HttpsError('already-exists', MSG_CODE_EXISTS);
    throw err;
  }
  try {
    const uses = await oldRef.collection('uses').get();
    const writes = [];
    for (const u of uses.docs) {
      writes.push((b) => b.set(newRef.collection('uses').doc(u.id), u.data()));
      writes.push((b) => b.set(db.doc(`users/${u.id}/private/billing`), { coupon: next }, { merge: true }));
    }
    for (const col of ['checkouts', 'payments']) {
      const refs = await db.collection(col).where('coupon', '==', old).get();
      for (const r of refs.docs) writes.push((b) => b.update(r.ref, { coupon: next }));
    }
    for (let i = 0; i < writes.length; i += 400) {
      const batch = db.batch();
      writes.slice(i, i + 400).forEach((w) => w(batch));
      await batch.commit();
    }
    await db.recursiveDelete(oldRef);
  } catch (err) {
    logger.error('renameCoupon: falhou no meio; desfazendo o novo', { old, next, err: safeErr(err) });
    await db.recursiveDelete(newRef).catch(() => {});
    throw new HttpsError('internal', 'Não foi possível renomear o cupom. Tente de novo.');
  }
  return { code: next };
}

// Só apaga cupom que ninguém usou; com cadastros, o histórico de conversão ficaria sem origem.
async function deleteCoupon(request) {
  adminOnly(request, 'excluir cupons');
  const code = codeArg(request.data && request.data.code, 'Cupom inválido.');
  const db = getFirestore();
  const ref = db.doc('coupons/' + code);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) throw new HttpsError('not-found', 'Cupom não encontrado.');
    if ((s.get('usedCount') || 0) > 0 || !(await tx.get(ref.collection('uses').limit(1))).empty) {
      throw new HttpsError('failed-precondition', 'Este cupom já tem cadastros. Desative em vez de excluir, para não perder o histórico.');
    }
    // O parceiro só aparece no painel pelos cupons dele: não dá para apagar o último.
    const mine = await tx.get(db.collection('coupons').where('partnerUid', '==', s.get('partnerUid')).limit(2));
    if (mine.size < 2) throw new HttpsError('failed-precondition', 'Este é o único cupom do parceiro. Crie outro antes de excluir.');
    tx.delete(ref);
  });
  return { code };
}

module.exports = { createPartner, createCoupon, renameCoupon, deleteCoupon, validate };
