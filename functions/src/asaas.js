// Cliente do Asaas (Checkout por API) e classificação dos webhooks.
// Decisões e corpos reais: docs/asaas-notas.md.
const fs = require('node:fs');
const path = require('node:path');

const ITEM_NAME = 'Do 0 aos 5 km';
const ITEM_DESCRIPTION = 'Programa de corrida de 10 semanas, em turma.';
const USER_AGENT = 'letz-0-a-5km';
const DEFAULT_MINUTES_TO_EXPIRE = 60;

let itemImage = null;
function itemImageBase64() {
  if (itemImage === null) {
    itemImage = fs.readFileSync(path.join(__dirname, '..', 'assets', 'item.png')).toString('base64');
  }
  return itemImage;
}

class AsaasError extends Error {
  constructor(message, status, errors) {
    super(message);
    this.name = 'AsaasError';
    this.status = status;
    this.errors = errors || [];
  }
}

function createClient({ baseUrl, apiKey, fetchImpl } = {}) {
  if (!baseUrl) throw new Error('asaas: baseUrl obrigatório');
  if (!apiKey) throw new Error('asaas: apiKey obrigatória');
  const doFetch = fetchImpl || globalThis.fetch;
  const root = String(baseUrl).replace(/\/+$/, '');

  async function request(method, pathname, body) {
    const init = {
      method,
      headers: {
        access_token: apiKey,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    init.signal = AbortSignal.timeout(15000);
    const res = await doFetch(`${root}${pathname}`, init);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const errors = (data && Array.isArray(data.errors) && data.errors) || [];
      const detail = errors.map((e) => e && e.description).filter(Boolean).join(' | ');
      throw new AsaasError(`Asaas ${method} ${pathname} → ${res.status}${detail ? `: ${detail}` : ''}`, res.status, errors);
    }
    return data;
  }

  async function createCheckout({ uid, value, maxInstallments, successUrl, cancelUrl, expiredUrl, minutesToExpire, customerData } = {}) {
    if (typeof uid !== 'string' || !uid) throw new Error('asaas: uid obrigatório');
    if (typeof value !== 'number' || !(value > 0)) throw new Error('asaas: value inválido');
    if (!Number.isInteger(maxInstallments) || maxInstallments < 1 || maxInstallments > 12) {
      throw new Error('asaas: maxInstallments deve ser de 1 a 12');
    }
    if (!successUrl || !cancelUrl) throw new Error('asaas: successUrl e cancelUrl obrigatórias');
    const minutes = minutesToExpire == null ? DEFAULT_MINUTES_TO_EXPIRE : minutesToExpire;
    if (!Number.isInteger(minutes) || minutes < 10 || minutes > 1440) {
      throw new Error('asaas: minutesToExpire deve ser de 10 a 1440');
    }

    const callback = { successUrl, cancelUrl };
    if (expiredUrl) callback.expiredUrl = expiredUrl;
    const body = {
      billingTypes: ['PIX', 'CREDIT_CARD'],
      chargeTypes: maxInstallments > 1 ? ['DETACHED', 'INSTALLMENT'] : ['DETACHED'],
      minutesToExpire: minutes,
      externalReference: uid,
      callback,
      items: [
        {
          name: ITEM_NAME,
          description: ITEM_DESCRIPTION,
          quantity: 1,
          value,
          imageBase64: itemImageBase64(),
        },
      ],
    };
    if (maxInstallments > 1) body.installment = { maxInstallmentCount: maxInstallments };
    // Com customerData o Asaas abre o checkout já com identificação e endereço preenchidos.
    if (customerData) body.customerData = customerData;

    const createdAt = Date.now();
    const data = await request('POST', '/checkouts', body);
    if (!data || !data.id || !data.link) throw new AsaasError('Asaas POST /checkouts: resposta sem id/link', 502);
    return {
      id: data.id,
      url: data.link,
      expiresAt: new Date(createdAt + minutes * 60000).toISOString(),
    };
  }

  async function cancelCheckout(id) {
    if (typeof id !== 'string' || !id) throw new Error('asaas: id do checkout obrigatório');
    await request('POST', `/checkouts/${encodeURIComponent(id)}/cancel`);
  }

  return { createCheckout, cancelCheckout };
}

const PAID_PAYMENT_EVENTS = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED']);
const REFUND_EVENTS = new Set(['PAYMENT_REFUNDED']);
const CHARGEBACK_EVENTS = new Set(['PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CHARGEBACK_DISPUTE']);
// Cartão reprovado pela análise de risco ou captura recusada depois do CHECKOUT_PAID.
const REJECT_EVENTS = new Set(['PAYMENT_REPROVED_BY_RISK_ANALYSIS', 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED']);
const METHODS = new Set(['PIX', 'CREDIT_CARD']);

function ignore() {
  return { kind: 'ignore', uid: null, checkoutId: null, paymentId: null, method: null, installments: null, installmentId: null, value: null, netValue: null };
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v) {
  return typeof v === 'string' && v ? v : null;
}

// Nº de parcelas da compra. O webhook de cobrança não traz installmentCount
// (no sandbox, só installmentNumber, o id do parcelamento e a descrição
// "Parcela N de M."). Ordem: installmentCount, se vier; "de M" da descrição;
// cartão sem parcelamento = 1; senão null.
function installmentsOf(p, method) {
  if (Number.isInteger(p.installmentCount) && p.installmentCount > 0) return p.installmentCount;
  const m = typeof p.description === 'string' && p.description.match(/Parcela\s+\d+\s+de\s+(\d+)/i);
  if (m) return Number(m[1]);
  if (method === 'CREDIT_CARD' && !str(p.installment)) return 1;
  return null;
}

function classifyEvent(body) {
  if (!body || typeof body !== 'object') return ignore();
  const event = body.event;

  if (event === 'CHECKOUT_PAID') {
    const c = body.checkout;
    if (!c || typeof c !== 'object' || !str(c.id)) return ignore();
    return { ...ignore(), kind: 'paid', uid: str(c.externalReference), checkoutId: c.id };
  }

  let kind = null;
  if (PAID_PAYMENT_EVENTS.has(event)) kind = 'paid';
  else if (REFUND_EVENTS.has(event)) kind = 'refunded';
  else if (CHARGEBACK_EVENTS.has(event)) kind = 'chargeback';
  else if (REJECT_EVENTS.has(event)) kind = 'rejected';
  if (!kind) return ignore();

  const p = body.payment;
  if (!p || typeof p !== 'object' || !str(p.id)) return ignore();
  const method = METHODS.has(p.billingType) ? p.billingType : null;
  return {
    kind,
    uid: null,
    checkoutId: str(p.checkoutSession),
    paymentId: p.id,
    method,
    installments: installmentsOf(p, method),
    installmentId: str(p.installment),
    value: num(p.value),
    netValue: num(p.netValue),
  };
}

module.exports = { createClient, classifyEvent, AsaasError };
