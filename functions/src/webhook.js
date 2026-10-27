// Webhook do Asaas: confere o token, registra o evento uma vez só (asaasEvents/{id})
// e aplica a mudança de acesso na mesma transação.
const crypto = require('node:crypto');
const logger = require('firebase-functions/logger');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { classifyEvent } = require('./asaas.js');
const { ASAAS_WEBHOOK_TOKEN } = require('./billing-config.js');
const { safeErr } = require('./safe.js');

const CLOSED = new Set(['refunded', 'chargeback', 'rejected']);

// Ids que viram caminho de documento: nunca confie no que vem do evento. O evento
// pode ser de outro produto da mesma conta Asaas, com externalReference qualquer.
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
// Id do evento do Asaas: "evt_<hex>&<número>".
const EVENT_ID_RE = /^[A-Za-z0-9_&.-]{1,200}$/;
const validId = (v) => typeof v === 'string' && ID_RE.test(v);

function tokenOk(given, expected) {
  if (typeof given !== 'string' || !given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Aplica um evento 'paid'. Devolve uma descrição curta do que fez (para o log).
function applyPaid(tx, refs, ev, { billing, checkout }, alert) {
  const now = FieldValue.serverTimestamp();
  // Dinheiro recebido sem acesso: nunca em silêncio.
  if (checkout && CLOSED.has(checkout.status)) {
    alert('paid-closed-checkout');
    return 'pago atrasado de checkout já ' + checkout.status;
  }
  if (CLOSED.has(billing.status) && billing.checkoutId === ev.checkoutId) {
    alert('paid-closed-checkout');
    return 'pago atrasado: billing já ' + billing.status;
  }

  if (billing.status === 'paid' && billing.checkoutId !== ev.checkoutId) {
    if (refs.checkout && checkout) tx.update(refs.checkout, { status: 'paid' });
    if (!billing.duplicate) {
      tx.update(refs.billing, { duplicate: true, updatedAt: now });
      alert('duplicate-payment');
    }
    return 'duplicate';
  }

  const update = {};
  if (billing.status !== 'paid') {
    Object.assign(update, { status: 'paid', checkoutId: ev.checkoutId, paidAt: now });
    tx.update(refs.user, { access: 'active' });
  }
  // CPF já foi (ou está indo) para outro cadastro, mas a pessoa pagou: ativa e sinaliza.
  const cpfGone = billing.cpfReleased === true || !!billing.cpfReclaimPendingBy;
  if (cpfGone && !billing.cpfConflict) {
    update.cpfConflict = true;
    alert('cpf-conflict');
  }
  if (ev.method && billing.method !== ev.method) update.method = ev.method;
  if (ev.installments && billing.installments !== ev.installments) update.installments = ev.installments;
  if (ev.paymentId && !billing.paymentId) update.paymentId = ev.paymentId;
  if (refs.checkout && checkout && checkout.status !== 'paid') tx.update(refs.checkout, { status: 'paid' });
  if (!Object.keys(update).length) return 'sem mudança';
  update.updatedAt = now;
  tx.update(refs.billing, update);
  if (update.cpfConflict) return 'cpfConflict';
  return billing.status === 'paid' ? 'detalhes do pagamento' : 'ativado';
}

function applyClosed(tx, refs, ev, { billing, checkout }) {
  const current = billing.status === 'paid' && billing.checkoutId === ev.checkoutId;
  // Estorno/chargeback sempre fecha o checkout (o dinheiro voltou); um pago tardio dele
  // cai no alerta paid-closed-checkout. 'rejected' só fecha o checkout pago e atual.
  const closeCheckout = ev.kind !== 'rejected' || current;
  if (closeCheckout && refs.checkout && checkout && !CLOSED.has(checkout.status)) tx.update(refs.checkout, { status: ev.kind });
  if (!current) return 'não é o checkout pago atual';
  tx.update(refs.billing, { status: ev.kind, updatedAt: FieldValue.serverTimestamp() });
  tx.update(refs.user, { access: 'blocked' });
  return 'bloqueado';
}

async function processEvent(db, body) {
  if (typeof body.id !== 'string' || !EVENT_ID_RE.test(body.id)) return { result: 'ignorado', warn: 'id de evento inválido' };
  const eventId = body.id;
  const ev = classifyEvent(body);
  // Valores fora do formato nunca viram caminho de documento.
  if (ev.uid && !validId(ev.uid)) ev.uid = null;
  if (ev.checkoutId && !validId(ev.checkoutId)) {
    return { result: 'ignorado', warn: 'checkoutId fora do formato', ev };
  }
  const eventRef = db.doc('asaasEvents/' + eventId);

  return db.runTransaction(async (tx) => {
    const seen = await tx.get(eventRef);
    if (seen.exists) return { result: 'repetido' };

    const coRef = ev.checkoutId ? db.doc('checkouts/' + ev.checkoutId) : null;
    const coSnap = coRef ? await tx.get(coRef) : null;
    const checkout = coSnap && coSnap.exists ? coSnap.data() : null;
    // checkouts/{id} foi gravado por nós; vale mais que o externalReference do evento.
    const ours = checkout && validId(checkout.uid) ? checkout.uid : null;
    let uid = ev.uid || ours;
    let mismatch = null;
    if (ev.uid && ours && ours !== ev.uid) {
      mismatch = { eventUid: ev.uid, checkoutUid: ours };
      uid = ours;
    }

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
    // Pago e não aplicado (ou que precisa do olho do treinador): alerta no painel.
    const alert = (type) => tx.create(db.collection('alerts').doc(), {
      type, uid: uid || null, checkoutId: ev.checkoutId || null, eventId, at: FieldValue.serverTimestamp(), resolved: false,
    });
    if (ev.kind === 'ignore') return { result: 'ignorado' };
    if (!uid || !userSnap.exists || !billingSnap.exists) {
      // Só vira alerta se parece nosso (uid no evento ou checkout nosso) e é pagamento.
      if (ev.kind === 'paid' && (ev.uid || ours)) {
        alert('unknown-uid');
        return { error: 'uid sem conta ou billing', ev, uid, mismatch };
      }
      return { result: 'ignorado', warn: 'evento sem conta nossa', ev, uid, mismatch };
    }

    const state = { billing: billingSnap.data(), checkout };
    const result = ev.kind === 'paid' ? applyPaid(tx, refs, ev, state, alert) : applyClosed(tx, refs, ev, state);
    return { result, uid, mismatch };
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
    if (out.mismatch) {
      logger.error('asaasWebhook: uid do evento difere do dono do checkout; vale o checkout', {
        eventId: body.id, ...out.mismatch,
      });
    }
    if (out.warn) {
      logger.warn('asaasWebhook: ' + out.warn, { event: typeof body.event === 'string' ? body.event.slice(0, 60) : null });
    } else if (out.error) {
      logger.error('asaasWebhook: ' + out.error, {
        eventId: body.id, event: body.event, uid: out.uid || null, checkoutId: out.ev.checkoutId, paymentId: out.ev.paymentId,
      });
    } else if (out.result === 'cpfConflict') {
      logger.error('asaasWebhook: conta paga com CPF já liberado para outro cadastro (cpfConflict)', { eventId: body.id, uid: out.uid });
    } else if (out.result === 'duplicate') {
      logger.error('asaasWebhook: segundo checkout pago para conta já paga', { eventId: body.id, uid: out.uid });
    } else {
      logger.info('asaasWebhook: ' + out.result, { eventId: body.id, event: body.event, uid: out.uid || null });
    }
    res.status(200).send('ok');
  } catch (err) {
    // 500 faz o Asaas reenviar; o evento não foi gravado porque a transação falhou.
    logger.error('asaasWebhook: falha ao processar', { eventId: body.id, err: safeErr(err) });
    res.status(500).send('error');
  }
}

module.exports = { asaasWebhook, processEvent, tokenOk };
