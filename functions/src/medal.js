// Callable da medalha: abre (ou reabre) o checkout de R$ 35 do aluno que concluiu o programa.
// O pedido fica em users/{uid}/private/medal; o webhook (Task 3) o leva a "paid".
const { HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const core = require('../shared/core.js');
const { asaasClient, medalCheckoutArgs, customerDataOf, MEDAL_PRICE } = require('./billing-config.js');
const { safeErr } = require('./safe.js');
const { marksFromPosts } = require('./points.js');
const { sendMail } = require('./mailer.js');
const { REFUND_LIMIT } = require('./signup.js');

const MSG_ADDRESS = 'Confira o endereço: CEP, rua, número, bairro, cidade e estado.';
const MSG_NOT_ELIGIBLE = 'A medalha é para quem concluiu o programa.';
const MSG_TAKEN = 'A medalha já foi paga.';
const MSG_LIMIT = 'Não foi possível comprar a medalha. Fale com a assessoria no WhatsApp.';
const MSG_UNAVAILABLE = 'Não conseguimos abrir o pagamento agora. Tente de novo em instantes.';
// O checkout salvo só é reaproveitado se ainda tiver esta folga até vencer.
const REUSE_MARGIN_MS = 5 * 60000;
const PAID = ['paid', 'shipped', 'delivered'];

const sameAddress = (a, b) => !!a && !!b && ['cep', 'street', 'number', 'complement', 'district', 'city', 'uf'].every((k) => a[k] === b[k]);
const reusable = (medal, address) => !!(medal && medal.status === 'pending' && medal.url && medal.expiresAt
  && medal.expiresAt.toMillis() - REUSE_MARGIN_MS > Date.now() && sameAddress(medal.address, address));

async function cancelQuietly(db, checkoutId) {
  if (!checkoutId) return;
  try {
    await asaasClient().cancelCheckout(checkoutId);
  } catch (err) {
    logger.error('startMedalCheckout: não cancelou o checkout', { checkoutId, err: safeErr(err) });
  }
  await db.doc('checkouts/' + checkoutId).set({ status: 'canceled' }, { merge: true }).catch(() => {});
}

// Conclusão conferida nos treinos marcados (posts), nunca no marcador users.concluded.
async function concludedByPosts(db, uid) {
  const posts = await db.collection('posts').where('uid', '==', uid).get();
  return core.isConcluded(marksFromPosts(posts));
}

async function startMedalCheckout(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Entre com seu e-mail e senha.');
  const uid = request.auth.uid;
  const d = request.data && typeof request.data === 'object' ? request.data : {};
  const db = getFirestore();

  const [user, profileSnap, medalSnap] = await Promise.all([
    db.doc('users/' + uid).get(), db.doc(`users/${uid}/private/profile`).get(), db.doc(`users/${uid}/private/medal`).get(),
  ]);
  if (!user.exists || user.get('access') !== 'active') throw new HttpsError('failed-precondition', MSG_NOT_ELIGIBLE);
  if (!(await concludedByPosts(db, uid))) throw new HttpsError('failed-precondition', MSG_NOT_ELIGIBLE);

  const profile = profileSnap.exists ? profileSnap.data() : null;
  let address;
  if (d.useSignupAddress === true) {
    address = core.cleanAddress(profile && profile.address);
    if (!address) throw new HttpsError('invalid-argument', MSG_ADDRESS);
  } else {
    address = core.cleanAddress(d.address);
    if (!address) throw new HttpsError('invalid-argument', MSG_ADDRESS);
  }

  const medal = medalSnap.exists ? medalSnap.data() : null;
  if (medal && PAID.includes(medal.status)) throw new HttpsError('failed-precondition', MSG_TAKEN);
  if (medal && (medal.refundCount || 0) >= REFUND_LIMIT) throw new HttpsError('failed-precondition', MSG_LIMIT);
  if (reusable(medal, address)) return { checkoutUrl: medal.url };

  const customerData = customerDataOf(user.get('name'), profile, address);
  const value = Number(MEDAL_PRICE.value());
  let checkout;
  try {
    checkout = await asaasClient().createCheckout(medalCheckoutArgs(uid, customerData));
  } catch (err) {
    logger.error('startMedalCheckout: Asaas falhou ao criar o checkout', { uid, status: err && err.status, err: safeErr(err) });
    throw new HttpsError('unavailable', MSG_UNAVAILABLE);
  }
  const expiresAt = Timestamp.fromDate(new Date(checkout.expiresAt));
  const medalRef = db.doc(`users/${uid}/private/medal`);
  const outcome = await db.runTransaction(async (tx) => {
    const cur = await tx.get(medalRef);
    const c = cur.exists ? cur.data() : null;
    if (c && PAID.includes(c.status)) return { taken: true };
    if (c && (c.refundCount || 0) >= REFUND_LIMIT) return { limit: true };
    // Outra chamada ganhou a corrida com um checkout novo e igual: fica com o dela.
    if (reusable(c, address) && c.checkoutId !== (medal && medal.checkoutId)) return { url: c.url, dup: true };
    tx.set(db.doc('checkouts/' + checkout.id), {
      kind: 'medal', uid, value, createdAt: FieldValue.serverTimestamp(), expiresAt, status: 'active',
    });
    tx.set(medalRef, {
      status: 'pending', address, checkoutId: checkout.id, url: checkout.url, expiresAt,
      refundCount: (c && c.refundCount) || 0, updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { url: checkout.url };
  });
  if (outcome.taken || outcome.limit || outcome.dup) {
    await cancelQuietly(db, checkout.id);
    if (outcome.taken) throw new HttpsError('failed-precondition', MSG_TAKEN);
    if (outcome.limit) throw new HttpsError('failed-precondition', MSG_LIMIT);
    return { checkoutUrl: outcome.url };
  }
  // O checkout pendente anterior (vencido ou de outro endereço) deixa de valer.
  if (medal && medal.status === 'pending' && medal.checkoutId) await cancelQuietly(db, medal.checkoutId);
  return { checkoutUrl: outcome.url };
}

// ---- Envio: callables do treinador (só admin) ----
const TRACKING_RE = /^[A-Za-z0-9-]{3,40}$/;
// Por onde se pode ir a partir de cada status: um passo à frente ou um passo atrás.
const NEXT = { paid: ['shipped'], shipped: ['delivered', 'paid'], delivered: ['shipped'] };
const MSG_TRACKING = 'Informe o código de rastreio (3 a 40 letras, números ou hífen).';
const MSG_DATE = 'Data inválida. Use o formato AAAA-MM-DD.';

const bad = (m) => new HttpsError('invalid-argument', m);

function requireAdmin(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Entre com seu e-mail e senha.');
  if (request.auth.token.admin !== true) throw new HttpsError('permission-denied', 'Só o treinador pode atualizar as medalhas.');
}

function uidOf(data) {
  const uid = data && typeof data === 'object' ? data.uid : null;
  if (typeof uid !== 'string' || !uid || uid.includes('/')) throw bad('Aluno inválido.');
  return uid;
}

// Data (AAAA-MM-DD) guardada como texto, sem fuso; padrão: hoje no horário de Brasília.
function dateOf(v) {
  if (v === undefined || v === null || v === '') return new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v) throw bad(MSG_DATE);
  return v;
}

const addressLine = (a) => `${a.street}, ${a.number}${a.complement ? ' (' + a.complement + ')' : ''} - ${a.district}, ${a.city}/${a.uf}, CEP ${a.cep}`;
const brDate = (iso) => iso.split('-').reverse().join('/');

// E-mail curto em pt-BR; sem dado de pagamento.
function shippedEmail(name, order) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'atleta';
  return {
    subject: 'Sua medalha Letz bora! foi enviada',
    text: [
      `Oi, ${first}!`,
      '',
      'Sua medalha Letz bora! foi enviada.',
      '',
      `Código de rastreio: ${order.trackingCode}`,
      `Data de envio: ${brDate(order.shippedAt)}`,
      `Endereço de entrega: ${addressLine(order.address)}`,
      '',
      'Qualquer dúvida, é só chamar a assessoria da Letz pelo WhatsApp.',
      '',
      'Letz Assessoria',
    ].join('\n'),
  };
}

// Falha de e-mail nunca desfaz o status: vira log e alerta no painel.
async function emailShipped(db, uid, order) {
  let sent = false;
  try {
    const [user, authUser] = await Promise.all([db.doc('users/' + uid).get(), getAuth().getUser(uid)]);
    if (!authUser.email) throw new Error('aluno sem e-mail');
    const { subject, text } = shippedEmail(user.get('name'), order);
    sent = (await sendMail({ to: authUser.email, subject, text })).sent === true;
  } catch (err) {
    logger.error('medalha: não montou o e-mail de envio', { uid, err: safeErr(err) });
  }
  if (sent) {
    await db.doc(`users/${uid}/private/medal`).update({ emailedAt: FieldValue.serverTimestamp(), emailedCount: FieldValue.increment(1) });
  } else {
    logger.error('medalha: e-mail de envio não saiu', { uid });
    await db.collection('alerts').add({ type: 'medal-email-failed', uid, at: FieldValue.serverTimestamp(), resolved: false });
  }
  return sent;
}

async function updateMedalOrder(request) {
  requireAdmin(request);
  const d = request.data && typeof request.data === 'object' ? request.data : {};
  const uid = uidOf(d);
  if (!['paid', 'shipped', 'delivered'].includes(d.status)) throw bad('Status inválido.');
  const db = getFirestore();
  const ref = db.doc(`users/${uid}/private/medal`);

  const out = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('failed-precondition', 'Esse aluno não tem pedido de medalha.');
    const cur = snap.data();
    const editing = cur.status === d.status && d.status !== 'paid';
    if (!editing && !(NEXT[cur.status] || []).includes(d.status)) {
      throw new HttpsError('failed-precondition', 'Essa mudança de status não é permitida.');
    }
    const patch = { status: d.status, updatedAt: FieldValue.serverTimestamp() };
    if (d.status === 'paid') {
      Object.assign(patch, { trackingCode: FieldValue.delete(), shippedAt: FieldValue.delete(), deliveredAt: FieldValue.delete() });
    } else {
      // Ao entrar em "shipped" o rastreio vem na chamada; só edições e "delivered" reaproveitam o salvo.
      const tracking = d.trackingCode !== undefined ? d.trackingCode : (cur.status === 'paid' ? undefined : cur.trackingCode);
      if (typeof tracking !== 'string' || !TRACKING_RE.test(tracking)) throw bad(MSG_TRACKING);
      patch.trackingCode = tracking;
      patch.shippedAt = d.shippedAt !== undefined || !cur.shippedAt ? dateOf(d.shippedAt) : cur.shippedAt;
      patch.deliveredAt = d.status === 'delivered' ? dateOf(d.deliveredAt) : FieldValue.delete();
    }
    tx.update(ref, patch);
    // O e-mail automático sai uma vez, na primeira passagem para "shipped".
    const first = d.status === 'shipped' && cur.status === 'paid' && !cur.emailedAt;
    return { first, order: { ...cur, ...patch } };
  });

  const emailed = out.first ? await emailShipped(db, uid, out.order) : false;
  return { ok: true, emailed };
}

async function resendMedalEmail(request) {
  requireAdmin(request);
  const uid = uidOf(request.data);
  const db = getFirestore();
  const snap = await db.doc(`users/${uid}/private/medal`).get();
  const order = snap.exists ? snap.data() : null;
  if (!order || !['shipped', 'delivered'].includes(order.status)) {
    throw new HttpsError('failed-precondition', 'O e-mail só pode ser reenviado para medalha enviada ou entregue.');
  }
  return { ok: true, emailed: await emailShipped(db, uid, order) };
}

// ---- Pedido de reembolso (aluno): só registra; o reembolso em si é manual no Asaas ----
const REFUND_WINDOW_MS = 7 * 864e5;
const MSG_REFUND_PROGRAM = 'O prazo de 7 dias para pedir reembolso do programa acabou. Fale com a assessoria no WhatsApp.';
const MSG_REFUND_MEDAL = 'Só dá para pedir reembolso da medalha antes do envio. Fale com a assessoria no WhatsApp.';
// Dia no horário de Brasília (AAAA-MM-DD): o pedido se renova uma vez por dia.
const dayOf = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 10);

async function requestRefund(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Entre com seu e-mail e senha.');
  const uid = request.auth.uid;
  const product = request.data && typeof request.data === 'object' ? request.data.product : null;
  if (product !== 'program' && product !== 'medal') throw bad('Produto inválido.');
  const ref = getFirestore().doc(`users/${uid}/private/${product === 'program' ? 'billing' : 'medal'}`);
  await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? snap.data() : null;
    if (product === 'program') {
      const paidAt = cur && cur.paidAt && typeof cur.paidAt.toMillis === 'function' ? cur.paidAt.toMillis() : null;
      if (!cur || cur.status !== 'paid' || paidAt === null) throw new HttpsError('failed-precondition', 'Não há pagamento do programa para reembolsar.');
      if (Date.now() - paidAt > REFUND_WINDOW_MS) throw new HttpsError('failed-precondition', MSG_REFUND_PROGRAM);
    } else if (!cur || cur.status !== 'paid') {
      throw new HttpsError('failed-precondition', MSG_REFUND_MEDAL);
    }
    const last = cur.refundRequestedAt && cur.refundRequestedAt.toMillis();
    if (last && dayOf(last) === dayOf(Date.now())) return; // já pediu hoje
    tx.update(ref, { refundRequestedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  });
  return { ok: true };
}

module.exports = { startMedalCheckout, requestRefund, updateMedalOrder, resendMedalEmail };
