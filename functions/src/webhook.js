// Webhook do Asaas: confere o token, registra o evento uma vez só (asaasEvents/{id})
// e aplica a mudança de acesso na mesma transação.
const crypto = require('node:crypto');
const logger = require('firebase-functions/logger');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { classifyEvent } = require('./asaas.js');
const { ASAAS_WEBHOOK_TOKEN } = require('./billing-config.js');

const CLOSED = new Set(['refunded', 'chargeback']);

function tokenOk(given, expected) {
  if (typeof given !== 'string' || !given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Aplica um evento 'paid'. Devolve uma descrição curta do que fez (para o log).
function applyPaid(tx, refs, ev, { billing, checkout }) {
  const now = FieldValue.serverTimestamp();
  if (checkout && CLOSED.has(checkout.status)) return 'pago atrasado de checkout já ' + checkout.status;

  if (billing.status === 'paid' && billing.checkoutId !== ev.checkoutId) {
    if (refs.checkout && checkout) tx.update(refs.checkout, { status: 'paid' });
    if (!billing.duplicate) tx.update(refs.billing, { duplicate: true, updatedAt: now });
    return 'duplicate';
  }

  const update = {};
  if (billing.status !== 'paid') {
    Object.assign(update, { status: 'paid', checkoutId: ev.checkoutId, paidAt: now });
    tx.update(refs.user, { access: 'active' });
  }
  if (ev.method && billing.method !== ev.method) update.method = ev.method;
  if (ev.installments && billing.installments !== ev.installments) update.installments = ev.installments;
  if (ev.paymentId && !billing.paymentId) update.paymentId = ev.paymentId;
  if (refs.checkout && checkout && checkout.status !== 'paid') tx.update(refs.checkout, { status: 'paid' });
  if (!Object.keys(update).length) return 'sem mudança';
  update.updatedAt = now;
  tx.update(refs.billing, update);
  return billing.status === 'paid' ? 'detalhes do pagamento' : 'ativado';
}

function applyClosed(tx, refs, ev, { billing, checkout }) {
  if (refs.checkout && checkout && !CLOSED.has(checkout.status)) tx.update(refs.checkout, { status: ev.kind });
  if (billing.status !== 'paid' || billing.checkoutId !== ev.checkoutId) return 'não é o checkout pago atual';
  tx.update(refs.billing, { status: ev.kind, updatedAt: FieldValue.serverTimestamp() });
  tx.update(refs.user, { access: 'blocked' });
  return 'bloqueado';
}

async function processEvent(db, body) {
  const eventId = String(body.id).replace(/\//g, '_');
  const ev = classifyEvent(body);
  const eventRef = db.doc('asaasEvents/' + eventId);

  return db.runTransaction(async (tx) => {
    const seen = await tx.get(eventRef);
    if (seen.exists) return { result: 'repetido' };

    const coRef = ev.checkoutId ? db.doc('checkouts/' + ev.checkoutId) : null;
    const coSnap = coRef ? await tx.get(coRef) : null;
    const checkout = coSnap && coSnap.exists ? coSnap.data() : null;
    const uid = ev.uid || (checkout && checkout.uid) || null;

    // Todas as leituras antes da primeira escrita (regra das transações).
    const refs = uid && ev.kind !== 'ignore' ? {
      user: db.doc('users/' + uid),
      billing: db.doc(`users/${uid}/private/billing`),
      checkout: checkout ? coRef : null,
    } : null;
    const [userSnap, billingSnap] = refs ? await Promise.all([tx.get(refs.user), tx.get(refs.billing)]) : [];

    tx.create(eventRef, {
      type: typeof body.event === 'string' ? body.event : null,
      uid,
      checkoutId: ev.checkoutId,
      paymentId: ev.paymentId,
      at: FieldValue.serverTimestamp(),
    });
    if (ev.kind === 'ignore') return { result: 'ignorado' };
    if (!uid) return { error: 'uid desconhecido', ev };
    if (!userSnap.exists || !billingSnap.exists) return { error: 'uid sem conta ou billing', ev, uid };

    const state = { billing: billingSnap.data(), checkout };
    const result = ev.kind === 'paid' ? applyPaid(tx, refs, ev, state) : applyClosed(tx, refs, ev, state);
    return { result, uid };
  });
}

async function asaasWebhook(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }
  if (!tokenOk(req.get('asaas-access-token'), ASAAS_WEBHOOK_TOKEN.value())) {
    res.status(401).send('Unauthorized');
    return;
  }
  const body = req.body;
  if (!body || typeof body !== 'object' || typeof body.id !== 'string' || !body.id) {
    res.status(400).send('Bad Request');
    return;
  }

  try {
    const out = await processEvent(getFirestore(), body);
    if (out.error) {
      logger.error('asaasWebhook: ' + out.error, {
        eventId: body.id, event: body.event, uid: out.uid || null, checkoutId: out.ev.checkoutId, paymentId: out.ev.paymentId,
      });
    } else if (out.result === 'duplicate') {
      logger.error('asaasWebhook: segundo checkout pago para conta já paga', { eventId: body.id, uid: out.uid });
    } else {
      logger.info('asaasWebhook: ' + out.result, { eventId: body.id, event: body.event, uid: out.uid || null });
    }
    res.status(200).send('ok');
  } catch (err) {
    // 500 faz o Asaas reenviar; o evento não foi gravado porque a transação falhou.
    logger.error('asaasWebhook: falha ao processar', { eventId: body.id, err: String(err) });
    res.status(500).send('error');
  }
}

module.exports = { asaasWebhook, processEvent, tokenOk };
