// Callables de venda: signup (cria a conta pendente e abre o checkout do Asaas)
// e resumeCheckout (devolve o checkout válido ou abre outro).
const crypto = require('node:crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const core = require('../shared/core.js');
const { asaasClient, checkoutArgs } = require('./billing-config.js');

// Uma só mensagem para CPF e e-mail repetidos: não revela qual dos dois existe.
const MSG_EXISTS = 'Já existe um cadastro com este CPF ou e-mail. Entre com seu e-mail e senha ou fale com a Letz.';
const MSG_UNAVAILABLE = 'Não conseguimos abrir o pagamento agora. Entre com seu e-mail e senha para tentar de novo.';
const MSG_SALES_CLOSED = 'As vendas desta turma estão fechadas.';
const MSG_RATE = 'Muitas tentativas. Tente de novo em alguns minutos.';
const MSG_PAID = 'O pagamento já foi feito.';
const MSG_CLOSED = 'Este cadastro foi encerrado. Fale com a Letz.';

const HOUR_MS = 3600e3;
// Reserva órfã (função caiu entre reservar o CPF e gravar a conta): retomável
// depois deste prazo, se o uid reservado não tiver users/{uid} nem conta no Auth.
const ORPHAN_RESERVATION_MS = 10 * 60000;
// Conta que nunca pagou libera o CPF para outro cadastro depois deste prazo.
const PENDING_RECLAIM_MS = 24 * HOUR_MS;
// O checkout salvo só é reaproveitado se ainda tiver esta folga até vencer.
const REUSE_MARGIN_MS = 5 * 60000;
// Limite de tentativas de cadastro por IP.
const RATE_MAX = 5;
const RATE_WINDOW_MS = HOUR_MS;

const exists = () => new HttpsError('already-exists', MSG_EXISTS);
const bad = (message) => new HttpsError('invalid-argument', message);

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

// Falhas injetáveis só no emulador (testes): testFaults/{name}.
async function faultValue(db, name, field) {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') return undefined;
  const snap = await db.doc('testFaults/' + name).get();
  return snap.exists ? snap.get(field) : undefined;
}
async function fault(db, name, flag) {
  return (await faultValue(db, name, flag)) === true;
}

const cpfHash = (cpf) => crypto.createHash('sha256').update(String(cpf)).digest('hex');

// Conta que perdeu o CPF (ou está perdendo) não paga nem abre checkout.
const cpfGone = (billing) => !!(billing && (billing.cpfReleased || billing.cpfReclaimPendingBy));

// IP do cliente: o último salto do x-forwarded-for, que é o acrescentado pelo
// front-end do Google (os anteriores vêm do cliente e podem ser forjados).
// Sem o cabeçalho, rawRequest.ip.
function clientIp(request) {
  const raw = request.rawRequest || {};
  const header = raw.headers && raw.headers['x-forwarded-for'];
  const xff = Array.isArray(header) ? header.join(',') : header;
  if (typeof xff === 'string') {
    const hops = xff.split(',').map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return raw.ip ? String(raw.ip) : 'desconhecido';
}

// Janela fixa de 1 h por IP (hash, para não guardar o IP em claro).
async function rateLimit(db, request) {
  const hash = crypto.createHash('sha256').update(clientIp(request)).digest('hex');
  const ref = db.doc('rateLimits/signup_' + hash);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const start = snap.exists && snap.get('windowStart') ? snap.get('windowStart').toMillis() : 0;
    if (!snap.exists || now - start >= RATE_WINDOW_MS) {
      tx.set(ref, {
        windowStart: Timestamp.fromMillis(now), count: 1, expiresAt: Timestamp.fromMillis(now + RATE_WINDOW_MS),
      });
      return;
    }
    if ((snap.get('count') || 0) >= RATE_MAX) throw new HttpsError('resource-exhausted', MSG_RATE);
    tx.update(ref, { count: FieldValue.increment(1) });
  });
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

// O dono atual de um CPF pode perdê-lo? 'orphan' (reserva sem conta), 'pending'
// (nunca pagou e foi criado há mais de 24 h) ou null (nunca: pago, bloqueado, recente).
async function reclaimKind(db, holder, reservation) {
  const [user, billing] = await Promise.all([
    db.doc('users/' + holder).get(),
    db.doc(`users/${holder}/private/billing`).get(),
  ]);
  if (!user.exists) {
    const at = reservation.get('at');
    const old = at && Date.now() - at.toMillis() > ORPHAN_RESERVATION_MS;
    return old && !(await authUserExists(holder)) ? 'orphan' : null;
  }
  const createdAt = user.get('createdAt');
  const pending = user.get('access') === 'pending' && billing.exists && billing.get('status') === 'pending';
  if (pending && createdAt && Date.now() - createdAt.toMillis() > PENDING_RECLAIM_MS) return 'pending';
  return null;
}

async function cancelCheckoutQuietly(db, checkoutId, why) {
  if (!checkoutId) return;
  try {
    await asaasClient().cancelCheckout(checkoutId);
  } catch (err) {
    logger.warn(`${why}: não cancelou o checkout no Asaas`, { checkoutId, err: String(err) });
  }
  const ref = db.doc('checkouts/' + checkoutId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.get('status') === 'active') tx.update(ref, { status: 'canceled' });
  }).catch((err) => logger.warn(`${why}: não marcou o checkout como cancelado`, { checkoutId, err: String(err) }));
}

// Reserva cpfs/{cpf} para uid. Falha com already-exists se o CPF tem dono que não pode perdê-lo.
// Retomada em duas fases: aqui aponta o CPF para o novo uid (com reclaimedFrom) e,
// na mesma transação, marca o billing antigo com cpfReclaimPendingBy (a conta antiga
// já não retoma o pagamento). cpfReleased e o cancelamento do checkout ficam para
// finishReclaim, depois que a conta nova foi gravada. Devolve {prev, prevAt, kind}
// (prev só quando a transação de fato tomou o CPF de outro uid).
async function reserveCpf(db, cpf, uid) {
  const ref = db.doc('cpfs/' + cpf);
  const existing = await ref.get();
  let prev = null;
  let kind = null;
  if (existing.exists && existing.get('uid') !== uid) {
    prev = existing.get('uid');
    kind = await reclaimKind(db, prev, existing);
    if (!kind) throw exists();
  }
  const took = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const holder = snap.exists ? snap.get('uid') : null;
    if (holder && holder !== uid && holder !== prev) throw exists();
    let prevBillingRef = null;
    if (holder && holder === prev && kind === 'pending') {
      prevBillingRef = db.doc(`users/${prev}/private/billing`);
      const billing = await tx.get(prevBillingRef);
      if (!billing.exists || billing.get('status') !== 'pending') throw exists();
    }
    const data = { uid, at: FieldValue.serverTimestamp() };
    if (holder && holder === prev) data.reclaimedFrom = prev;
    tx.set(ref, data);
    if (prevBillingRef) {
      tx.update(prevBillingRef, { cpfReclaimPendingBy: uid, updatedAt: FieldValue.serverTimestamp() });
    }
    return holder && holder === prev ? { prevAt: snap.get('at') || null } : null;
  });
  return took ? { prev, prevAt: took.prevAt, kind } : { prev: null, prevAt: null, kind: null };
}

// Segunda fase da retomada: só depois que a conta nova existe. Troca o marcador
// cpfReclaimPendingBy por cpfReleased numa transação (com uma nova tentativa).
// Se falhar de vez, o marcador fica: a conta antiga continua sem retomar o pagamento.
async function finishReclaim(db, cpf, uid, { prev, kind }) {
  if (!prev) return;
  logger.info('signup: CPF retomado de outra conta', { from: prev, to: uid, kind });
  if (kind !== 'pending') return;
  const billingRef = db.doc(`users/${prev}/private/billing`);
  let checkoutId = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (await fault(db, 'signup', 'failFinishReclaim')) throw new Error('falha simulada no finishReclaim');
      checkoutId = await db.runTransaction(async (tx) => {
        const billing = await tx.get(billingRef);
        if (!billing.exists) return null;
        const update = {
          cpfReleased: true, cpfReclaimPendingBy: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp(),
        };
        if (billing.get('status') !== 'pending' && !billing.get('cpfConflict')) {
          update.cpfConflict = true;
          logger.error('signup: conta antiga pagou durante a retomada do CPF (cpfConflict)', { from: prev, to: uid });
        }
        tx.update(billingRef, update);
        return billing.get('status') === 'pending' ? billing.get('checkoutId') || null : null;
      });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) {
    logger.error('signup: não marcou cpfReleased na conta antiga; cpfReclaimPendingBy fica', {
      from: prev, to: uid, cpfSha256: cpfHash(cpf), err: String(lastErr),
    });
    return;
  }
  await cancelCheckoutQuietly(db, checkoutId, 'signup');
}

// Desfaz a reserva: devolve o CPF ao dono anterior (retomada) ou apaga.
// Só mexe se cpfs/{cpf} ainda aponta para este uid. Na devolução, limpa o
// cpfReclaimPendingBy que esta tentativa deixou no billing antigo.
async function releaseCpf(db, cpf, uid, prev = null, prevAt = null) {
  const ref = db.doc('cpfs/' + cpf);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('uid') !== uid) return;
    const prevBillingRef = prev ? db.doc(`users/${prev}/private/billing`) : null;
    const prevBilling = prevBillingRef ? await tx.get(prevBillingRef) : null;
    if (prev) tx.set(ref, { uid: prev, at: prevAt || FieldValue.serverTimestamp() });
    else tx.delete(ref);
    if (prevBilling && prevBilling.exists && prevBilling.get('cpfReclaimPendingBy') === uid) {
      tx.update(prevBillingRef, { cpfReclaimPendingBy: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
    }
  }).catch((err) => logger.error('signup: não liberou o CPF reservado', { uid, prev, err: String(err) }));
}

async function deleteAuthUser(uid) {
  await getAuth().deleteUser(uid).catch((err) => {
    if (!err || err.code !== 'auth/user-not-found') logger.error('signup: não removeu o usuário do Auth', { uid, err: String(err) });
  });
}

// Erro ambíguo do createUser (rede, timeout): a conta pode ter sido criada.
// Só remove se for a conta deste cadastro (mesmo uid) e ainda sem users/{uid}.
async function cleanupAmbiguousCreate(db, uid, email) {
  try {
    const user = await getAuth().getUserByEmail(email);
    if (user.uid !== uid) return;
    const doc = await db.doc('users/' + uid).get();
    if (!doc.exists) await deleteAuthUser(uid);
  } catch (err) {
    if (!err || err.code !== 'auth/user-not-found') {
      logger.error('signup: não conferiu a conta após erro do createUser', { uid, err: String(err) });
    }
  }
}

// Abre um checkout no Asaas e grava checkouts/{id} e o billing, se ainda pendente.
// Se o billing deixou de estar pendente (pagamento chegou no meio), cancela o novo checkout.
async function openCheckout(db, uid) {
  const checkout = await asaasClient().createCheckout(checkoutArgs(uid));
  const expiresAt = Timestamp.fromDate(new Date(checkout.expiresAt));
  const billingRef = db.doc(`users/${uid}/private/billing`);
  const saved = await db.runTransaction(async (tx) => {
    const billing = await tx.get(billingRef);
    const gone = billing.exists && cpfGone(billing.data());
    const ok = billing.exists && billing.get('status') === 'pending' && !gone;
    tx.set(db.doc('checkouts/' + checkout.id), {
      uid, createdAt: FieldValue.serverTimestamp(), expiresAt, status: ok ? 'active' : 'canceled',
    });
    if (ok) {
      tx.update(billingRef, {
        checkoutId: checkout.id, url: checkout.url, expiresAt, updatedAt: FieldValue.serverTimestamp(),
      });
    }
    return ok ? 'ok' : (gone ? 'closed' : 'paid');
  });
  if (saved !== 'ok') {
    try {
      await asaasClient().cancelCheckout(checkout.id);
    } catch (err) {
      logger.error('openCheckout: não cancelou o checkout aberto em corrida com o pagamento', { uid, checkoutId: checkout.id, err: String(err) });
    }
    throw new HttpsError('failed-precondition', saved === 'closed' ? MSG_CLOSED : MSG_PAID);
  }
  return checkout.url;
}

async function signup(request) {
  const { name, email, password, cpf, phone } = validate(request.data);
  const db = getFirestore();
  await rateLimit(db, request);

  const config = await db.doc('config/app').get();
  if (config.exists && config.get('salesOpen') === false) {
    throw new HttpsError('failed-precondition', MSG_SALES_CLOSED);
  }

  // E-mail já cadastrado: falha antes de tocar em qualquer CPF.
  try {
    await getAuth().getUserByEmail(email);
    throw exists();
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    if (!err || err.code !== 'auth/user-not-found') {
      logger.error('signup: getUserByEmail falhou', { err: String(err) });
      throw new HttpsError('internal', 'Não foi possível criar a conta. Tente de novo.');
    }
  }

  const uid = db.collection('users').doc().id;
  const reservation = await reserveCpf(db, cpf, uid);
  const undoCpf = () => releaseCpf(db, cpf, uid, reservation.prev, reservation.prevAt);
  // Só nos testes: segura a função entre a fase 1 da retomada e o resto.
  const pauseMs = await faultValue(db, 'signup', 'pauseAfterReserveMs');
  if (typeof pauseMs === 'number' && pauseMs > 0) await new Promise((r) => setTimeout(r, Math.min(pauseMs, 15000)));

  try {
    await getAuth().createUser({ uid, email, password, displayName: name });
  } catch (err) {
    const code = (err && err.code) || '';
    if (code === 'auth/email-already-exists') {
      await undoCpf();
      throw exists();
    }
    if (code === 'auth/invalid-email' || code === 'auth/invalid-password') {
      await undoCpf();
      throw bad(code === 'auth/invalid-email' ? 'Informe um e-mail válido.' : 'A senha precisa ter pelo menos 6 caracteres.');
    }
    logger.error('signup: createUser falhou', { uid, code, err: String(err) });
    await cleanupAmbiguousCreate(db, uid, email);
    await undoCpf();
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
  try {
    if (await fault(db, 'signup', 'failBatch')) throw new Error('falha simulada no batch');
    await batch.commit();
  } catch (err) {
    logger.error('signup: não gravou a conta; desfazendo', { uid, err: String(err) });
    await deleteAuthUser(uid);
    await undoCpf();
    throw new HttpsError('internal', 'Não foi possível criar a conta. Tente de novo.');
  }

  await finishReclaim(db, cpf, uid, reservation);

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
  if (billing && billing.status === 'paid') throw new HttpsError('failed-precondition', MSG_PAID);
  if (cpfGone(billing)) throw new HttpsError('failed-precondition', MSG_CLOSED);
  if (!user.exists || user.get('access') !== 'pending' || !billing || billing.status !== 'pending') {
    throw new HttpsError('failed-precondition', 'Esta conta não tem pagamento pendente.');
  }

  if (billing.url && billing.expiresAt && billing.expiresAt.toMillis() - REUSE_MARGIN_MS > Date.now()) {
    return { checkoutUrl: billing.url };
  }

  await cancelCheckoutQuietly(db, billing.checkoutId, 'resumeCheckout');

  try {
    return { checkoutUrl: await openCheckout(db, uid) };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    logger.error('resumeCheckout: Asaas falhou ao criar o checkout', { uid, status: err && err.status, err: String(err) });
    throw new HttpsError('unavailable', 'Não conseguimos abrir o pagamento agora. Tente de novo em instantes.');
  }
}

module.exports = { signup, resumeCheckout, validate, MSG_EXISTS };
