// Callables de venda: signup (cria a conta pendente e abre o checkout do Asaas)
// e resumeCheckout (devolve o checkout válido ou abre outro).
const crypto = require('node:crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const core = require('../shared/core.js');
const { asaasClient, checkoutArgs, customerDataOf, PROGRAM_PRICE } = require('./billing-config.js');
const { safeErr } = require('./safe.js');

// Uma só mensagem para CPF e e-mail repetidos: não revela qual dos dois existe.
const MSG_EXISTS = 'Já existe um cadastro com este CPF ou e-mail. Entre com seu e-mail e senha ou fale com a Letz.';
const MSG_UNAVAILABLE = 'Não conseguimos abrir o pagamento agora. Entre com seu e-mail e senha para tentar de novo.';
const MSG_SALES_CLOSED = 'As vendas desta turma estão fechadas.';
const MSG_RATE = 'Muitas tentativas. Tente de novo em alguns minutos.';
const MSG_PAID = 'O pagamento já foi feito.';
const MSG_CLOSED = 'Este cadastro foi encerrado. Fale com a Letz.';
const MSG_NO_REBUY = 'Não foi possível comprar de novo. Fale com a assessoria no WhatsApp.';
// Pode comprar de novo enquanto refundCount < 2 (uma recompra por produto).
const REFUND_LIMIT = 2;
// Estados do programa em que a conta voltou a ficar fechada e pode ser recomprada.
const REBUYABLE = ['refunded', 'chargeback', 'rejected'];
// Uma só mensagem para cupom inexistente, inativo, vencido ou esgotado: não revela qual.
const MSG_COUPON = 'Cupom inválido ou esgotado.';
const COUPON_RE = /^[A-Z0-9]{4,20}$/;
const round2 = (n) => Math.round(n * 100) / 100;

const HOUR_MS = 3600e3;
// Reserva órfã (função caiu entre reservar o CPF e gravar a conta): retomável
// depois deste prazo, se o uid reservado não tiver users/{uid} nem conta no Auth.
const ORPHAN_RESERVATION_MS = 10 * 60000;
// Conta que nunca pagou libera o CPF para outro cadastro depois deste prazo.
const PENDING_RECLAIM_MS = 24 * HOUR_MS;
// O checkout salvo só é reaproveitado se ainda tiver esta folga até vencer.
const REUSE_MARGIN_MS = 5 * 60000;
// Limite de tentativas de cadastro por IP.
const RATE_MAX = 20; // por IP/hora (CGNAT de operadoras brasileiras)
const SPIKE_MAX = 300; // só alerta (nunca bloqueia): cadastros concluídos por hora
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
  const address = core.cleanAddress(d.address);
  if (!address) throw bad('Confira o endereço: CEP, rua, número, bairro, cidade e estado.');
  if (d.acceptPolicy !== true) throw bad('É preciso aceitar a política de privacidade.');
  let coupon = null;
  if (d.coupon !== undefined && d.coupon !== null && d.coupon !== '') {
    if (typeof d.coupon !== 'string') throw bad(MSG_COUPON);
    coupon = d.coupon.trim().toUpperCase() || null;
    if (coupon && !COUPON_RE.test(coupon)) throw bad(MSG_COUPON);
  }
  return { name, email, password, cpf, phone, address, coupon };
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

// Cupom utilizável: existe, ativo, não vencido e (se tiver limite) com cadastros sobrando.
function couponUsable(snap) {
  if (!snap.exists) return false;
  if (snap.get('active') !== true) return false;
  const exp = snap.get('expiresAt');
  if (exp && exp.toMillis() <= Date.now()) return false;
  const max = snap.get('maxUses');
  if (typeof max === 'number' && (snap.get('usedCount') || 0) >= max) return false;
  const pct = snap.get('percent');
  return Number.isInteger(pct) && pct >= 1 && pct <= 50;
}

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

// Janela fixa de 1 h por IP (hash, para não guardar o IP em claro). Único limite que bloqueia.
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

// Conta cadastros CONCLUÍDOS na hora; passou de SPIKE_MAX, grava um alerta (uma vez por
// janela) e um warn. Nunca recusa nada nem derruba o cadastro.
async function noteSignupSuccess(db) {
  try {
    const ref = db.doc('rateLimits/signup_success');
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = Date.now();
      const start = snap.exists && snap.get('windowStart') ? snap.get('windowStart').toMillis() : 0;
      if (!snap.exists || now - start >= RATE_WINDOW_MS) {
        tx.set(ref, {
          windowStart: Timestamp.fromMillis(now), count: 1, alerted: false, expiresAt: Timestamp.fromMillis(now + RATE_WINDOW_MS),
        });
        return;
      }
      const count = (snap.get('count') || 0) + 1;
      const upd = { count };
      if (count > SPIKE_MAX && !snap.get('alerted')) {
        upd.alerted = true;
        tx.create(db.collection('alerts').doc(), { type: 'signup-spike', count, at: FieldValue.serverTimestamp(), resolved: false });
        logger.warn('signup: pico de cadastros na última hora', { count });
      }
      tx.update(ref, upd);
    });
  } catch (err) {
    logger.warn('signup: não contou o cadastro concluído', { err: safeErr(err) });
  }
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
    logger.warn(`${why}: não cancelou o checkout no Asaas`, { checkoutId, err: safeErr(err) });
  }
  const ref = db.doc('checkouts/' + checkoutId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.get('status') === 'active') tx.update(ref, { status: 'canceled' });
  }).catch((err) => logger.warn(`${why}: não marcou o checkout como cancelado`, { checkoutId, err: safeErr(err) }));
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
      from: prev, to: uid, err: safeErr(lastErr),
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
  }).catch((err) => logger.error('signup: não liberou o CPF reservado', { uid, prev, err: safeErr(err) }));
}

async function deleteAuthUser(uid) {
  await getAuth().deleteUser(uid).catch((err) => {
    if (!err || err.code !== 'auth/user-not-found') logger.error('signup: não removeu o usuário do Auth', { uid, err: safeErr(err) });
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
      logger.error('signup: não conferiu a conta após erro do createUser', { uid, err: safeErr(err) });
    }
  }
}

// Abre um checkout no Asaas e grava checkouts/{id} e o billing, se ainda pendente.
// Se o billing deixou de estar pendente (pagamento chegou no meio), cancela o novo checkout.
// rebuy: recompra de conta reembolsada. Preço cheio (sem cupom) e, na mesma transação, o
// billing volta a "pending" (refundCount < 2); o acesso segue bloqueado até o webhook.
async function openCheckout(db, uid, { rebuy = false } = {}) {
  const [userDoc, profileDoc, billingDoc] = await Promise.all([
    db.doc('users/' + uid).get(), db.doc(`users/${uid}/private/profile`).get(), db.doc(`users/${uid}/private/billing`).get(),
  ]);
  const customerData = customerDataOf(userDoc.get('name'), profileDoc.exists ? profileDoc.data() : null);
  // Conta com cupom: o valor com desconto foi fixado no cadastro e é o mesmo em toda reabertura.
  const coupon = !rebuy && billingDoc.exists ? billingDoc.get('coupon') || null : null;
  const percent = coupon ? billingDoc.get('percent') : null;
  const value = coupon ? billingDoc.get('value') : undefined;
  const checkout = await asaasClient().createCheckout(checkoutArgs(uid, customerData, value));
  const expiresAt = Timestamp.fromDate(new Date(checkout.expiresAt));
  const billingRef = db.doc(`users/${uid}/private/billing`);
  const saved = await db.runTransaction(async (tx) => {
    const billing = await tx.get(billingRef);
    const gone = billing.exists && cpfGone(billing.data());
    const status = billing.exists ? billing.get('status') : null;
    const limit = rebuy && billing.exists && (billing.get('refundCount') || 0) >= REFUND_LIMIT;
    const open = rebuy ? REBUYABLE.includes(status) || (status === 'pending' && !!billing.get('rebuyAt')) : status === 'pending';
    const ok = open && !gone && !limit;
    tx.set(db.doc('checkouts/' + checkout.id), {
      uid, createdAt: FieldValue.serverTimestamp(), expiresAt, status: ok ? 'active' : 'canceled',
      ...(coupon ? { coupon, percent, value } : {}),
    });
    if (ok) {
      const upd = { checkoutId: checkout.id, url: checkout.url, expiresAt, updatedAt: FieldValue.serverTimestamp() };
      if (rebuy) {
        const del = FieldValue.delete();
        Object.assign(upd, {
          status: 'pending', rebuyAt: FieldValue.serverTimestamp(),
          coupon: del, percent: del, value: del, paidAt: del, paymentId: del, method: del, installments: del,
          duplicate: del, refundRequestedAt: del,
        });
      }
      tx.update(billingRef, upd);
    }
    return ok ? 'ok' : (gone ? 'closed' : (limit ? 'limit' : 'paid'));
  });
  if (saved !== 'ok') {
    try {
      await asaasClient().cancelCheckout(checkout.id);
    } catch (err) {
      logger.error('openCheckout: não cancelou o checkout aberto em corrida com o pagamento', { uid, checkoutId: checkout.id, err: safeErr(err) });
    }
    if (saved === 'limit') throw new HttpsError('failed-precondition', MSG_NO_REBUY);
    throw new HttpsError('failed-precondition', saved === 'closed' ? MSG_CLOSED : MSG_PAID);
  }
  return checkout.url;
}

// Interruptor de vendas (config/app.salesOpen === false): vale para signup e recompra.
async function assertSalesOpen(db) {
  const config = await db.doc('config/app').get();
  if (config.exists && config.get('salesOpen') === false) {
    throw new HttpsError('failed-precondition', MSG_SALES_CLOSED);
  }
}

async function signup(request) {
  const { name, email, password, cpf, phone, address, coupon } = validate(request.data);
  const db = getFirestore();
  await rateLimit(db, request);

  await assertSalesOpen(db);

  // E-mail já cadastrado: falha antes de tocar em qualquer CPF.
  try {
    await getAuth().getUserByEmail(email);
    throw exists();
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    if (!err || err.code !== 'auth/user-not-found') {
      logger.error('signup: getUserByEmail falhou', { err: safeErr(err) });
      throw new HttpsError('internal', 'Não foi possível criar a conta. Tente de novo.');
    }
  }

  // Confere o cupom cedo (leitura simples) para não criar/apagar conta à toa.
  // A validação que vale é a da transação que grava a conta.
  if (coupon && !couponUsable(await db.doc('coupons/' + coupon).get())) throw new HttpsError('failed-precondition', MSG_COUPON);

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
    logger.error('signup: createUser falhou', { uid, code, err: safeErr(err) });
    await cleanupAmbiguousCreate(db, uid, email);
    await undoCpf();
    throw new HttpsError('internal', 'Não foi possível criar a conta. Tente de novo.');
  }

  const now = FieldValue.serverTimestamp();
  const userDoc = {
    name, handle: '', photoURL: '', profiled: false, welcomed: false,
    access: 'pending', points: 0, done: 0, createdAt: now,
  };
  const profileDoc = { email, cpf, phone, address, policyAcceptedAt: now };
  const billingDoc = { checkoutId: null, url: null, expiresAt: null, status: 'pending', updatedAt: now };
  try {
    if (await fault(db, 'signup', 'failBatch')) throw new Error('falha simulada no batch');
    if (coupon) {
      // Cadastro com cupom: conta e uso do cupom na mesma transação (o limite não estoura em corrida).
      const couponRef = db.doc('coupons/' + coupon);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(couponRef);
        if (!couponUsable(snap)) throw new HttpsError('failed-precondition', MSG_COUPON);
        const percent = snap.get('percent');
        const value = round2(Number(PROGRAM_PRICE.value()) * (1 - percent / 100));
        tx.update(couponRef, { usedCount: FieldValue.increment(1) });
        tx.create(db.doc(`coupons/${coupon}/uses/${uid}`), {
          name, partnerUid: snap.get('partnerUid') || null, at: now, status: 'signed-up',
        });
        tx.create(db.doc('users/' + uid), userDoc);
        tx.create(db.doc(`users/${uid}/private/profile`), profileDoc);
        tx.create(db.doc(`users/${uid}/private/billing`), { ...billingDoc, coupon, percent, value });
      });
    } else {
      const batch = db.batch();
      batch.set(db.doc('users/' + uid), userDoc);
      batch.set(db.doc(`users/${uid}/private/profile`), profileDoc);
      batch.set(db.doc(`users/${uid}/private/billing`), billingDoc);
      await batch.commit();
    }
  } catch (err) {
    const couponErr = err instanceof HttpsError;
    if (!couponErr) logger.error('signup: não gravou a conta; desfazendo', { uid, err: safeErr(err) });
    await deleteAuthUser(uid);
    await undoCpf();
    if (couponErr) throw err;
    throw new HttpsError('internal', 'Não foi possível criar a conta. Tente de novo.');
  }

  await finishReclaim(db, cpf, uid, reservation);

  try {
    const checkoutUrl = await openCheckout(db, uid);
    await noteSignupSuccess(db);
    return { checkoutUrl };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    // A conta e o CPF ficam com este uid; o aluno entra e usa resumeCheckout.
    logger.error('signup: Asaas falhou ao criar o checkout', { uid, status: err && err.status, err: safeErr(err) });
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
    logger.error('resumeCheckout: Asaas falhou ao criar o checkout', { uid, status: err && err.status, err: safeErr(err) });
    throw new HttpsError('unavailable', 'Não conseguimos abrir o pagamento agora. Tente de novo em instantes.');
  }
}

// Recompra do programa: conta reembolsada (ou estornada/reprovada) paga de novo, uma vez.
// Tudo conferido aqui; o app só esconde o botão. O acesso continua "blocked" até o webhook.
async function rebuyProgram(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Entre com seu e-mail e senha.');
  const uid = request.auth.uid;
  const db = getFirestore();
  await assertSalesOpen(db);
  const [user, billingSnap] = await Promise.all([
    db.doc('users/' + uid).get(),
    db.doc(`users/${uid}/private/billing`).get(),
  ]);
  const billing = billingSnap.exists ? billingSnap.data() : null;
  const reopened = !!billing && billing.status === 'pending' && !!billing.rebuyAt;
  // Só conta bloqueada recompra: quem o treinador liberou à mão já está com acesso.
  if (!user.exists || user.get('access') !== 'blocked' || !billing || !(REBUYABLE.includes(billing.status) || reopened)) {
    throw new HttpsError('failed-precondition', MSG_NO_REBUY);
  }
  if (cpfGone(billing)) throw new HttpsError('failed-precondition', MSG_CLOSED);
  if ((billing.refundCount || 0) >= REFUND_LIMIT) throw new HttpsError('failed-precondition', MSG_NO_REBUY);

  if (reopened) {
    if (billing.url && billing.expiresAt && billing.expiresAt.toMillis() - REUSE_MARGIN_MS > Date.now()) {
      return { checkoutUrl: billing.url };
    }
    await cancelCheckoutQuietly(db, billing.checkoutId, 'rebuyProgram');
  }
  try {
    return { checkoutUrl: await openCheckout(db, uid, { rebuy: true }) };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    logger.error('rebuyProgram: Asaas falhou ao criar o checkout', { uid, status: err && err.status, err: safeErr(err) });
    throw new HttpsError('unavailable', 'Não conseguimos abrir o pagamento agora. Tente de novo em instantes.');
  }
}

module.exports = { signup, resumeCheckout, rebuyProgram, REFUND_LIMIT, validate, MSG_EXISTS };
