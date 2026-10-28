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
    address: { cep: '50050-000', street: 'Rua da Aurora', number: '100', complement: '', district: 'Boa Vista', city: 'Recife', uf: 'PE' },
  };
}

// ViaCEP é externo: responde sempre o mesmo endereço, ou "erro" para o CEP 00000-000.
export async function mockViaCep(page) {
  await page.route('https://viacep.com.br/**', (route) => {
    const cep = route.request().url().match(/ws\/(\d{8})/)?.[1];
    const body = cep === '00000000' ? { erro: true }
      : { cep, logradouro: 'Rua da Aurora', bairro: 'Boa Vista', localidade: 'Recife', uf: 'PE' };
    return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
}

// Preenche o endereço do cadastro pela tela (CEP achado → só o número).
export async function fillAddress(page, p) {
  await page.getByLabel('CEP').fill(p.address.cep);
  await page.getByLabel('Número').fill(p.address.number);
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

// Aluno com 24 treinos incluindo o 10-2 (medalha liberada), gravados pelo Admin SDK.
export async function seedConcluded(u) {
  const keys = [];
  for (let w = 1; w <= 7; w++) for (let d = 0; d < 3; d++) keys.push([w, d]);
  keys.push([8, 0], [8, 1], [10, 2], [9, 0], [9, 1], [9, 2]);
  const base = Date.now() - 60 * 864e5;
  let i = 0;
  for (const [w, d] of keys.slice(0, 24)) {
    i += 1;
    await db.doc(`posts/${u.uid}_${w}-${d}`).set({
      uid: u.uid, handle: u.handle, name: u.name, photoURL: '', w, d,
      at: admin.firestore.Timestamp.fromMillis(base + i * 864e5),
      comment: '', photoPath: '', imgURL: '', hidden: false, authorActive: true,
    });
  }
}

// ---------- app do aluno ----------
let hseq = 0;
export function uniqueHandle() {
  hseq += 1;
  return `ale${Date.now().toString(36)}${hseq}`.slice(0, 28);
}

// Aluno ativo com perfil pronto (handle reservado, boas-vindas vistas).
export async function makeAthlete(extra = {}) {
  const handle = extra.handle || uniqueHandle();
  const u = await makeUser('active', { profiled: true, welcomed: true, handle, ...extra });
  await db.doc('handles/' + handle).set({ uid: u.uid });
  return { ...u, handle };
}

// Abertura da semana 1 em `ms` (padrão: 2 dias atrás, então só a semana 1 está aberta).
export async function setStart(ms = Date.now() - 2 * 864e5) {
  await db.doc('config/app').set({ start: admin.firestore.Timestamp.fromMillis(ms), salesOpen: true });
}

export async function resetStart() {
  await db.doc('config/app').set({
    start: admin.firestore.Timestamp.fromDate(new Date('2026-11-08T18:00:00-03:00')), salesOpen: true,
  });
}

export async function waitUntil(fn, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('waitUntil: tempo esgotado');
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Metadados de um objeto do Storage (emulador, como dono do bucket).
export async function storageObject(path, bucket = 'demo-letz.appspot.com') {
  const res = await fetch(`http://127.0.0.1:9199/v0/b/${bucket}/o/${encodeURIComponent(path)}`, {
    headers: { authorization: 'Bearer owner' },
  });
  return res.ok ? res.json() : null;
}
