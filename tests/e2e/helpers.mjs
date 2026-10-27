// Utilidades do e2e: Admin SDK apontado para os emuladores do demo-letz.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';

const require = createRequire(import.meta.url);
const admin = require('firebase-admin');

export const PROJECT = 'demo-letz';
export const FN = `http://127.0.0.1:5001/${PROJECT}/southamerica-east1`;
export const AUTH = 'http://127.0.0.1:9099';
export const FAKE = 'http://127.0.0.1:7777';
export const WEBHOOK = `${FN}/asaasWebhook`;

if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
export const db = admin.firestore();
export const auth = admin.auth();
export { admin };

const events = JSON.parse(readFileSync(new URL('../functions/fixtures/asaas-events.json', import.meta.url), 'utf8'));

// Token do webhook: o valor falso que o emulador lê de functions/.secret.local.
export function webhookToken() {
  const text = readFileSync(new URL('../../functions/.secret.local', import.meta.url), 'utf8');
  const line = text.split('\n').find((l) => l.startsWith('ASAAS_WEBHOOK_TOKEN='));
  return line ? line.slice('ASAAS_WEBHOOK_TOKEN='.length).trim() : '';
}

export function checkoutPaid(uid, checkoutId) {
  const e = structuredClone(events.checkoutPaidPix);
  e.id = 'evt_e2e_' + Math.random();
  e.checkout.id = checkoutId;
  e.checkout.externalReference = uid;
  return e;
}

// CPF válido gerado na hora (dígitos verificadores calculados).
export function makeCpf() {
  const base = String(100000000 + Math.floor(Math.random() * 899999999)).slice(0, 9).split('').map(Number);
  for (let n = 9; n < 11; n++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += base[i] * (n + 1 - i);
    base.push((sum * 10) % 11 % 10);
  }
  return base.join('');
}

let seq = 0;
export function person() {
  seq += 1;
  const id = `${Date.now()}-${seq}`;
  return {
    name: 'Aluna E2E ' + seq,
    email: `e2e-${id}@exemplo.com`,
    password: 'senha-forte-123',
    cpf: makeCpf(),
    phone: '(81) 99999-0000',
  };
}

// Chama um callable pelo protocolo HTTP (sem o SDK Web).
export async function callable(name, data, idToken) {
  const headers = { 'content-type': 'application/json' };
  if (idToken) headers.authorization = 'Bearer ' + idToken;
  const res = await fetch(`${FN}/${name}`, { method: 'POST', headers, body: JSON.stringify({ data }) });
  return res.json();
}

// Conta no Auth + users/{uid} com o acesso pedido (sem passar pelo Asaas).
export async function makeUser(access, extra = {}) {
  const p = person();
  const u = await auth.createUser({ email: p.email, password: p.password, displayName: p.name });
  await db.doc('users/' + u.uid).set({
    name: p.name, handle: '', photoURL: '', profiled: false, welcomed: false,
    access, points: 0, done: 0, createdAt: admin.firestore.FieldValue.serverTimestamp(), ...extra,
  });
  return { ...p, uid: u.uid };
}

export async function makeCoach() {
  const p = person();
  const u = await auth.createUser({ email: p.email, password: p.password });
  await auth.setCustomUserClaims(u.uid, { admin: true });
  return { ...p, uid: u.uid };
}

export async function clearRateLimits() {
  await db.recursiveDelete(db.collection('rateLimits'));
}
