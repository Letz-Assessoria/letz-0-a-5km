// Antes dos e2e: sobe o Asaas falso (porta 7777), espera as Functions carregarem,
// limpa os dados dos emuladores e grava config/app.
import { startFakeAsaas } from '../fake-asaas.mjs';
import { admin, db, AUTH, PROJECT, FN, FAKE } from './helpers.mjs';

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (await fn()) return;
    } catch {
      // ainda subindo
    }
    if (Date.now() > end) throw new Error('global-setup: tempo esgotado esperando ' + what);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export default async function globalSetup() {
  let fake = null;
  try {
    fake = await startFakeAsaas({ port: 7777 });
  } catch (err) {
    if (err && err.code !== 'EADDRINUSE') throw err; // já há um rodando: reaproveita
  }
  await fetch(`${FAKE}/__reset`, { method: 'POST' });

  // Callable carregado responde JSON (unauthenticated); antes disso, 404.
  await waitFor(async () => {
    const r = await fetch(`${FN}/resumeCheckout`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: null }),
    });
    const b = await r.json().catch(() => null);
    return !!(b && b.error);
  }, 120_000, 'as Functions');

  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  for (const c of ['users', 'cpfs', 'checkouts', 'asaasEvents', 'config', 'rateLimits', 'testFaults', 'handles', 'posts']) {
    await db.recursiveDelete(db.collection(c));
  }
  await db.doc('config/app').set({
    start: admin.firestore.Timestamp.fromDate(new Date('2026-11-08T18:00:00-03:00')),
    salesOpen: true,
  });

  return async () => {
    if (fake) await fake.close();
  };
}
