// Callables de venda: signup (cria a conta pendente e abre o checkout do Asaas)
// e resumeCheckout (devolve o checkout válido ou abre outro).
const { HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const core = require('../shared/core.js');
const { asaasClient, checkoutArgs } = require('./billing-config.js');

const MSG_CPF_EXISTS = 'Este CPF já tem cadastro. Entre com seu e-mail e senha.';
const MSG_EMAIL_EXISTS = 'Este e-mail já tem cadastro. Entre com seu e-mail e senha.';
const MSG_UNAVAILABLE = 'Não conseguimos abrir o pagamento agora. Entre com seu e-mail e senha para tentar de novo.';
const MSG_SALES_CLOSED = 'As vendas desta turma estão fechadas.';

// Reserva de CPF órfã (função caiu entre reservar e criar a conta) pode ser
// retomada depois deste prazo, se o uid reservado não existir no Auth.
const STALE_RESERVATION_MS = 10 * 60000;
// O checkout salvo só é reaproveitado se ainda tiver esta folga até vencer.
const REUSE_MARGIN_MS = 5 * 60000;

function bad(message) {
  return new HttpsError('invalid-argument', message);
}

function validate(data) {
  const d = data && typeof data === 'object' ? data : {};
  const name = typeof d.name === 'string' ? d.name.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2 || name.length > 80) throw bad('Informe seu nome.');
  const email = typeof d.email === 'string' ? d.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw bad('Informe um e-mail válido.');
  const password = typeof d.password === 'string' ? d.password : '';
  if (password.length < 6 || password.length > 128) throw bad('A senha precisa ter pelo menos 6 caracteres.');
  if (typeof d.cpf !== 'string' || !core.isValidCpf(d.cpf)) throw bad('CPF inválido.');
  const cpf = core.normalizeCpf(d.cpf);
  const phone = typeof d.phone === 'string' ? core.normalizePhone(d.phone) : null;
  if (!phone) throw bad('Informe um celular com DDD.');
  if (d.acceptPolicy !== true) throw bad('É preciso aceitar a política de privacidade.');
  return { name, email, password, cpf, phone };
}

async function authUserExists(uid) {
  try {
    await getAuth().getUser(uid);
    return true;
  } catch (err) {
    if (err && err.code === 'auth/user-not-found') return false;
    throw err;
  }
}

// Reserva cpfs/{cpf} para uid. Falha com already-exists se outro uid já tem o CPF.
async function reserveCpf(db, cpf, uid) {
  const ref = db.doc('cpfs/' + cpf);
  const existing = await ref.get();
  if (existing.exists && existing.get('uid') !== uid) {
    const at = existing.get('at');
    const stale = at && Date.now() - at.toMillis() > STALE_RESERVATION_MS;
    if (!stale || (await authUserExists(existing.get('uid')))) {
      throw new HttpsError('already-exists', MSG_CPF_EXISTS);
    }
  }
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.get('uid') !== uid) {
      const prev = existing.exists ? existing.get('uid') : null;
      if (snap.get('uid') !== prev) throw new HttpsError('already-exists', MSG_CPF_EXISTS);
    }
    tx.set(ref, { uid, at: FieldValue.serverTimestamp() });
  });
}

async function releaseCpf(db, cpf, uid) {
  const ref = db.doc('cpfs/' + cpf);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.get('uid') === uid) tx.delete(ref);
  }).catch((err) => logger.error('signup: não liberou o CPF reservado', { uid, err: String(err) }));
}

// Abre um checkout no Asaas e grava checkouts/{id} e o billing (se ainda pendente).
async function openCheckout(db, uid) {
  const checkout = await asaasClient().createCheckout(checkoutArgs(uid));
  const expiresAt = Timestamp.fromDate(new Date(checkout.expiresAt));
  const billingRef = db.doc(`users/${uid}/private/billing`);
  const saved = await db.runTransaction(async (tx) => {
    const billing = await tx.get(billingRef);
    tx.set(db.doc('checkouts/' + checkout.id), {
      uid, createdAt: FieldValue.serverTimestamp(), expiresAt, status: 'active',
    });
    if (billing.exists && billing.get('status') !== 'pending') return false;
    tx.set(billingRef, {
      checkoutId: checkout.id, url: checkout.url, expiresAt, status: 'pending', updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return true;
  });
  if (!saved) throw new HttpsError('failed-precondition', 'O pagamento já foi feito.');
  return checkout.url;
}

async function signup(request) {
  const { name, email, password, cpf, phone } = validate(request.data);
  const db = getFirestore();

  const config = await db.doc('config/app').get();
  if (config.exists && config.get('salesOpen') === false) {
    throw new HttpsError('failed-precondition', MSG_SALES_CLOSED);
  }

  const uid = db.collection('users').doc().id;
  await reserveCpf(db, cpf, uid);

  try {
    await getAuth().createUser({ uid, email, password, displayName: name });
  } catch (err) {
    await releaseCpf(db, cpf, uid);
    const code = err && err.code;
    if (code === 'auth/email-already-exists') throw new HttpsError('already-exists', MSG_EMAIL_EXISTS);
    if (code === 'auth/invalid-email') throw bad('Informe um e-mail válido.');
    if (code === 'auth/invalid-password') throw bad('A senha precisa ter pelo menos 6 caracteres.');
    logger.error('signup: createUser falhou', { err: String(err) });
    throw new HttpsError('internal', 'Não foi possível criar a conta. Tente de novo.');
  }

  const now = FieldValue.serverTimestamp();
  const batch = db.batch();
  batch.set(db.doc('users/' + uid), {
    name, handle: '', photoURL: '', profiled: false, welcomed: false,
    access: 'pending', points: 0, done: 0, createdAt: now,
  });
  batch.set(db.doc(`users/${uid}/private/profile`), { email, cpf, phone, policyAcceptedAt: now });
  batch.set(db.doc(`users/${uid}/private/billing`), {
    checkoutId: null, url: null, expiresAt: null, status: 'pending', updatedAt: now,
  });
  await batch.commit();

  try {
    return { checkoutUrl: await openCheckout(db, uid) };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    // A conta e o CPF ficam com este uid; o aluno entra e usa resumeCheckout.
    logger.error('signup: Asaas falhou ao criar o checkout', { uid, status: err && err.status, err: String(err) });
    throw new HttpsError('unavailable', MSG_UNAVAILABLE);
  }
}

async function resumeCheckout(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Entre com seu e-mail e senha.');
  const uid = request.auth.uid;
  const db = getFirestore();
  const [user, billingSnap] = await Promise.all([
    db.doc('users/' + uid).get(),
    db.doc(`users/${uid}/private/billing`).get(),
  ]);
  const billing = billingSnap.exists ? billingSnap.data() : null;
  if (billing && billing.status === 'paid') throw new HttpsError('failed-precondition', 'O pagamento já foi feito.');
  if (!user.exists || user.get('access') !== 'pending' || !billing || billing.status !== 'pending') {
    throw new HttpsError('failed-precondition', 'Esta conta não tem pagamento pendente.');
  }

  if (billing.url && billing.expiresAt && billing.expiresAt.toMillis() - REUSE_MARGIN_MS > Date.now()) {
    return { checkoutUrl: billing.url };
  }

  if (billing.checkoutId) {
    try {
      await asaasClient().cancelCheckout(billing.checkoutId);
    } catch (err) {
      logger.warn('resumeCheckout: não cancelou o checkout antigo', { uid, checkoutId: billing.checkoutId, err: String(err) });
    }
    await db.doc('checkouts/' + billing.checkoutId)
      .update({ status: 'canceled' })
      .catch((err) => logger.warn('resumeCheckout: checkout antigo sem documento', { err: String(err) }));
  }

  try {
    return { checkoutUrl: await openCheckout(db, uid) };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    logger.error('resumeCheckout: Asaas falhou ao criar o checkout', { uid, status: err && err.status, err: String(err) });
    throw new HttpsError('unavailable', 'Não conseguimos abrir o pagamento agora. Tente de novo em instantes.');
  }
}

module.exports = { signup, resumeCheckout, validate };
