// e2e do painel do treinador: acesso, bloqueio, moderação, data da turma e vendas.
import { test, expect } from '@playwright/test';
import {
  admin, auth, clearRateLimits, db, fillAddress, makeAthlete, makeCoach, makeUser, mockViaCep, person, resetStart, seedConcluded, setStart,
  uniqueHandle, waitUntil,
} from './helpers.mjs';

let pageErrors = [];
test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await setStart();
});
test.afterEach(() => {
  expect(pageErrors, 'erros de JavaScript na página').toEqual([]);
});
test.afterAll(async () => { await resetStart(); });

async function login(page, u) {
  await page.goto('/#/entrar');
  await page.getByLabel('E-mail').fill(u.email);
  await page.getByLabel('Senha', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
}
async function coachPanel(page, section) {
  const c = await makeCoach();
  await login(page, c);
  await expect(page).toHaveURL(/#\/admin\//);
  if (section) await page.getByRole('group', { name: 'Seções' }).getByRole('button', { name: section }).click();
  return c;
}
async function tab(page, name) {
  await page.getByRole('navigation', { name: 'Principal' }).getByRole('button', { name }).click();
}
async function withProfile(u, extra = {}) {
  await db.doc(`users/${u.uid}/private/profile`).set({ email: u.email, cpf: '12345678909', phone: '5581999990000', policyAcceptedAt: new Date() });
  await db.doc(`users/${u.uid}/private/billing`).set({ status: 'pending', method: 'PIX', installments: 1, ...extra });
}
const row = (page, text) => page.locator('tr', { hasText: text });

test('liberar acesso manual leva aluno pendente ao app', async ({ page, browser }) => {
  const s = await makeUser('pending', { profiled: true, welcomed: true, handle: uniqueHandle() });
  await withProfile(s);
  await coachPanel(page, 'Atletas');
  const r = row(page, s.email);
  await expect(r).toContainText(s.email);
  await expect(page.locator('body')).not.toContainText('12345678909');
  await r.getByRole('button', { name: 'Liberar acesso' }).click();
  await waitUntil(async () => (await db.doc('users/' + s.uid).get()).data().access === 'active');

  const ctx = await browser.newContext();
  const ps = await ctx.newPage();
  await login(ps, s);
  await expect(ps).toHaveURL(/#\/app\/treinos$/);
  await ctx.close();
});

test('bloquear tira o aluno do feed e do ranking; reativar devolve', async ({ page, browser }) => {
  const a = await makeAthlete({ points: 3, done: 1 });
  await withProfile(a, { status: 'paid' });
  await db.doc(`posts/${a.uid}_1-0`).set({
    uid: a.uid, handle: a.handle, name: a.name, photoURL: '', w: 1, d: 0, at: admin.firestore.Timestamp.now(),
    comment: 'treino do bloqueio', photoPath: '', imgURL: '', hidden: false, authorActive: true,
  });
  const b = await makeAthlete();
  const ctx = await browser.newContext();
  const pb = await ctx.newPage();
  await login(pb, b);
  await tab(pb, 'Feed');
  await expect(pb.getByText('treino do bloqueio')).toBeVisible();
  await tab(pb, 'Ranking');
  await expect(pb.getByText('@' + a.handle).first()).toBeVisible();

  await coachPanel(page, 'Atletas');
  await row(page, a.email).getByRole('button', { name: 'Bloquear' }).click();
  await tab(pb, 'Feed');
  await expect(pb.getByText('treino do bloqueio')).toHaveCount(0);
  await tab(pb, 'Ranking');
  await expect(pb.getByText('@' + a.handle)).toHaveCount(0);

  await row(page, a.email).getByRole('button', { name: 'Liberar acesso' }).click();
  await tab(pb, 'Feed');
  await expect(pb.getByText('treino do bloqueio')).toBeVisible();
  await tab(pb, 'Ranking');
  await expect(pb.getByText('@' + a.handle).first()).toBeVisible();
  await ctx.close();
});

test('esconder post some o conteúdo mas mantém pontos', async ({ page, browser }) => {
  const a = await makeAthlete({ points: 3, done: 1 });
  await db.doc(`posts/${a.uid}_1-0`).set({
    uid: a.uid, handle: a.handle, name: a.name, photoURL: '', w: 1, d: 0, at: admin.firestore.Timestamp.now(),
    comment: 'post para esconder', photoPath: '', imgURL: '', hidden: false, authorActive: true,
  });
  const b = await makeAthlete();
  const ctx = await browser.newContext();
  const pb = await ctx.newPage();
  await login(pb, b);
  await tab(pb, 'Feed');
  await expect(pb.getByText('post para esconder')).toBeVisible();

  await coachPanel(page, 'Feed');
  await page.getByRole('button', { name: 'Esconder post' }).first().click();
  await waitUntil(async () => (await db.doc(`posts/${a.uid}_1-0`).get()).data().hidden === true);
  await expect(page.getByRole('button', { name: 'Restaurar post' })).toBeVisible();
  await expect(pb.getByText('post para esconder')).toHaveCount(0);
  expect((await db.doc('users/' + a.uid).get()).data().points).toBe(3);
  await tab(pb, 'Ranking');
  await expect(pb.getByText('@' + a.handle).first()).toBeVisible();

  await page.getByRole('button', { name: 'Restaurar post' }).click();
  await waitUntil(async () => (await db.doc(`posts/${a.uid}_1-0`).get()).data().hidden === false);
  await ctx.close();
});

test('financeiro: KPIs, vendas, busca e ficha do cliente a partir de payments', async ({ page }) => {
  await db.recursiveDelete(db.collection('payments'));
  const a = await makeAthlete({ name: 'Ana Financeira' });
  const b = await makeAthlete({ name: 'Bruno Reembolsado' });
  const c = await makeUser('pending', { name: 'Carla Aguardando', profiled: true, welcomed: true, handle: uniqueHandle() });
  await db.doc(`users/${a.uid}/private/profile`).set({ email: a.email, cpf: '12345678909', phone: '5581999990000', policyAcceptedAt: new Date(), address: { cep: '50000000', street: 'Rua A', number: '1', complement: '', district: 'Centro', city: 'Recife', uf: 'PE' } });
  await db.doc(`users/${a.uid}/private/billing`).set({ status: 'paid', method: 'CREDIT_CARD', installments: 12 });
  await db.doc(`users/${b.uid}/private/profile`).set({ email: b.email, cpf: '98765432100', phone: '', policyAcceptedAt: new Date() });
  await db.doc(`users/${b.uid}/private/billing`).set({ status: 'refunded', method: 'PIX', installments: 1 });
  await withProfile(c);
  const now = new Date();
  await db.doc('payments/ck-ana-1').set({ uid: a.uid, checkoutId: 'ck-ana-1', status: 'paid', method: 'CREDIT_CARD', installments: 12, gross: 159, net: 152.28, product: 'Do 0 aos 5 km', paidAt: now, updatedAt: now });
  await db.doc('payments/ck-bru-1').set({ uid: b.uid, checkoutId: 'ck-bru-1', status: 'refunded', method: 'PIX', installments: null, gross: 159, net: 157.01, product: 'Do 0 aos 5 km', paidAt: now, updatedAt: now });
  await db.doc('payments/ck-pix-2').set({ uid: a.uid, checkoutId: 'ck-pix-2', status: 'paid', method: 'PIX', installments: null, gross: 159, net: 157.01, product: 'Do 0 aos 5 km', paidAt: now, updatedAt: now });

  await coachPanel(page);
  await expect(page).toHaveURL(/#\/admin\/financeiro$/);
  const kpi = (n) => page.locator(`[data-kpi="${n}"]`);
  await expect(kpi('liquida')).toContainText('R$ 309,29');
  await expect(kpi('liquida')).toContainText('R$ 318,00 bruto');
  await expect(kpi('aprovadas').locator('b')).toHaveText('2');
  await expect(kpi('aprovadas')).toContainText('Ticket médio R$ 154,64');
  await expect(kpi('reembolsos').locator('b')).toHaveText('1');
  await expect(page.locator('.fcol').first()).toBeVisible();
  await expect(page.locator('.fmrow', { hasText: 'Cartão' })).toContainText('1 · 50%');

  await page.getByRole('group', { name: 'Financeiro' }).getByRole('button', { name: 'Vendas' }).click();
  const rows = page.locator('table[data-fin="vendas"] tbody tr');
  await expect(rows.filter({ hasText: 'Cartão 12x' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Cartão 12x' })).toContainText('Aprovada');
  await expect(rows.filter({ hasText: 'Bruno Reembolsado' })).toContainText('Reembolsada');
  await expect(rows.filter({ hasText: 'Carla Aguardando' })).toContainText('Aguardando pagamento');
  await expect(rows.filter({ hasText: 'Carla Aguardando' })).toContainText('R$ 159,00');
  await page.getByRole('group', { name: 'Situação' }).getByRole('button', { name: /Reembolsada/ }).click();
  await expect(rows).toHaveCount(1);
  await page.getByRole('group', { name: 'Situação' }).getByRole('button', { name: /Todas/ }).click();
  await page.getByLabel(/Buscar por/).fill('ck-pix-2');
  await expect(rows).toHaveCount(1);
  await page.getByLabel(/Buscar por/).fill(b.email.toUpperCase());
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Bruno Reembolsado');
  await page.getByLabel(/Buscar por/).fill('zzzz-nada');
  await expect(page.getByText('Nenhuma venda encontrada com esse filtro.')).toBeVisible();
  await page.getByLabel(/Buscar por/).fill('');

  await page.getByRole('group', { name: 'Financeiro' }).getByRole('button', { name: 'Clientes' }).click();
  const cli = page.locator('table[data-fin="clientes"] tbody tr', { hasText: 'Ana Financeira' });
  await expect(cli).toContainText('2');
  await expect(cli).toContainText('R$ 309,29');
  await cli.getByRole('button', { name: 'Ana Financeira' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText(a.email);
  await expect(sheet).toContainText('Recife/PE');
  await expect(sheet.getByRole('link', { name: '5581999990000' })).toHaveAttribute('href', 'https://wa.me/5581999990000');
  await expect(sheet).toContainText('pedido ck-ana-1');
  await expect(page.locator('body')).not.toContainText('12345678909');
  await expect(page.locator('body')).not.toContainText('98765432100');
  await sheet.getByRole('button', { name: 'Fechar', exact: true }).last().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('financeiro sem vendas mostra o estado vazio', async ({ page }) => {
  await db.recursiveDelete(db.collection('payments'));
  const pend = await db.collection('users').get();
  const had = [];
  for (const d of pend.docs) {
    const b = await d.ref.collection('private').doc('billing').get();
    if (b.exists && b.data().status === 'pending') { had.push([d.ref, b.data()]); await d.ref.collection('private').doc('billing').update({ status: 'canceled' }); }
  }
  try {
    await coachPanel(page);
    await expect(page.getByText('Nenhuma venda registrada ainda.')).toBeVisible();
  } finally {
    for (const [ref, data] of had) await ref.collection('private').doc('billing').set(data);
  }
});

test('treinos: edição vira rascunho e só grava em Salvar alterações; Descartar volta', async ({ page }) => {
  await coachPanel(page, 'Treinos');
  const box = page.locator('#t-1-0');
  const original = await box.inputValue();
  await expect(page.getByRole('button', { name: 'Salvar alterações' })).toBeDisabled();
  await expect(page.getByText('Nenhuma alteração')).toBeVisible();
  await box.fill('Treino editado pelo painel');
  await expect(page.getByText('Alterações não salvas')).toBeVisible();
  await box.blur();
  await page.waitForTimeout(400);
  expect(((await db.doc('config/app').get()).data() || {}).texts?.['1-0']).not.toBe('Treino editado pelo painel');
  await page.getByRole('button', { name: 'Descartar' }).click();
  await expect(box).toHaveValue(original);
  await expect(page.getByRole('button', { name: 'Salvar alterações' })).toBeDisabled();

  await box.fill('Treino editado pelo painel');
  await page.getByRole('button', { name: 'Salvar alterações' }).click();
  await expect(page.getByText('Alterações salvas')).toBeVisible();
  await waitUntil(async () => ((await db.doc('config/app').get()).data().texts || {})['1-0'] === 'Treino editado pelo painel');
  await box.fill('');
  await page.getByRole('button', { name: 'Salvar alterações' }).click();
  await waitUntil(async () => ((await db.doc('config/app').get()).data().texts || {})['1-0'] === undefined);
});

test('conteúdo: vídeos, links e grupo só gravam em Salvar alterações, com validação https', async ({ page }) => {
  await coachPanel(page, 'Conteúdo');
  await page.getByLabel('Link de convite do grupo no WhatsApp').fill('http://inseguro.example/x');
  await page.getByRole('button', { name: 'Salvar alterações' }).click();
  await expect(page.getByText('Confira os links: todos precisam começar com https://')).toBeVisible();
  await page.getByLabel('Link de convite do grupo no WhatsApp').fill('https://chat.whatsapp.com/abc123');
  await page.getByLabel('Link do vídeo da assessoria').fill('https://youtu.be/xyz');
  await page.getByRole('button', { name: 'Adicionar vídeo' }).click();
  await page.locator('input[data-vf="t"]').last().fill('Vídeo novo');
  await page.locator('input[data-vf="u"]').last().fill('https://youtu.be/novo');
  await page.waitForTimeout(400);
  expect(((await db.doc('config/app').get()).data() || {}).grupo).not.toBe('https://chat.whatsapp.com/abc123');
  await page.getByRole('button', { name: 'Salvar alterações' }).click();
  await expect(page.getByText('Alterações salvas')).toBeVisible();
  await waitUntil(async () => {
    const d = (await db.doc('config/app').get()).data();
    return d.grupo === 'https://chat.whatsapp.com/abc123' && d.av === 'https://youtu.be/xyz'
      && d.videos.some((v) => v.t === 'Vídeo novo' && v.u === 'https://youtu.be/novo');
  });
  await page.getByLabel('Link de convite do grupo no WhatsApp').fill('https://chat.whatsapp.com/outro');
  await page.getByRole('button', { name: 'Descartar' }).click();
  await expect(page.getByLabel('Link de convite do grupo no WhatsApp')).toHaveValue('https://chat.whatsapp.com/abc123');
  // limpa o que o teste gravou
  await db.doc('config/app').set({ grupo: '', av: '', videos: admin.firestore.FieldValue.delete() }, { merge: true });
});

// ---------- medalhas ----------
const ADDR = { cep: '50030230', street: 'Rua da Aurora', number: '123', complement: 'Apto 4', district: 'Boa Vista', city: 'Recife', uf: 'PE' };
const ADDR_TXT = 'Rua da Aurora, 123 (Apto 4) - Boa Vista, Recife/PE, CEP 50030-230';
// Aluno que concluiu, com (ou sem) pedido de medalha gravado pelo Admin SDK.
async function concludedAthlete(name, medal) {
  // O marcador users.concluded vem dos posts (e é recalculado quando a data da turma muda): semeia treinos de verdade.
  const a = await makeAthlete({ name });
  await seedConcluded(a);
  await waitUntil(async () => (await db.doc('users/' + a.uid).get()).data().concluded === true);
  if (medal) await db.doc(`users/${a.uid}/private/medal`).set({ address: ADDR, refundCount: 0, updatedAt: new Date(), ...medal });
  return a;
}
const mrow = (page, name) => page.locator('tr[data-medal]', { hasText: name });
const mcount = async (page, k) => Number(await page.locator(`[data-count="${k}"]`).innerText());

test('medalhas: marcar enviado com rastreio, contadores, e-mail, copiar endereço e voltar um passo', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const a = await concludedAthlete('Marina Medalha Pago', { status: 'paid', checkoutId: 'ck-med-1', paidAt: new Date() });
  await concludedAthlete('Nando Medalha Sem Compra', null);
  await db.doc('testMail/last').delete();
  await coachPanel(page, 'Medalhas');
  const r = mrow(page, 'Marina Medalha Pago');
  await expect(r).toContainText('Pago, aguardando envio');
  await expect(mrow(page, 'Nando Medalha Sem Compra')).toContainText('Não comprou');
  const [paid0, shipped0, none0] = [await mcount(page, 'paid'), await mcount(page, 'shipped'), await mcount(page, 'none')];
  expect(paid0).toBeGreaterThanOrEqual(1);
  expect(none0).toBeGreaterThanOrEqual(1);

  // endereço completo e botão de copiar
  await expect(r).toContainText(ADDR_TXT);
  await r.getByRole('button', { name: 'Copiar endereço' }).click();
  await expect(r.getByRole('button', { name: 'Copiado' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ADDR_TXT);

  // sem rastreio: erro do servidor em role=alert, status não muda
  await r.getByRole('button', { name: 'Marcar enviado' }).click();
  await expect(r.getByLabel('Data de envio')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await r.getByRole('button', { name: 'Confirmar envio' }).click();
  await expect(r.getByRole('alert')).toContainText('código de rastreio');
  expect((await db.doc(`users/${a.uid}/private/medal`).get()).data().status).toBe('paid');

  // com rastreio e data
  await r.getByLabel('Código de rastreio').fill('BR123456789XX');
  await r.getByLabel('Data de envio').fill('2026-11-20');
  await r.getByRole('button', { name: 'Confirmar envio' }).click();
  await expect(r).toContainText('Enviado');
  await expect(r).toContainText('BR123456789XX');
  await expect(r).toContainText('Enviado em 20/11/2026');
  await expect(r.locator('[data-mail="ok"]')).toContainText('E-mail enviado');
  expect(await mcount(page, 'paid')).toBe(paid0 - 1);
  expect(await mcount(page, 'shipped')).toBe(shipped0 + 1);
  const mail = await waitUntil(async () => (await db.doc('testMail/last').get()).data());
  expect(mail.to).toBe(a.email);
  expect(mail.text).toContain('BR123456789XX');
  const m1 = (await db.doc(`users/${a.uid}/private/medal`).get()).data();
  expect(m1.status).toBe('shipped');
  expect(m1.shippedAt).toBe('2026-11-20');

  // reenviar e-mail
  const n0 = (await db.doc('testMail/last').get()).data().n;
  await r.getByRole('button', { name: 'Reenviar e-mail' }).click();
  await expect(r.getByRole('status')).toContainText('E-mail reenviado');
  expect((await db.doc('testMail/last').get()).data().n).toBe(n0 + 1);

  // entregue e voltar um passo
  await r.getByRole('button', { name: 'Marcar entregue' }).click();
  await expect(r).toContainText('Entregue em');
  expect(await mcount(page, 'delivered')).toBeGreaterThanOrEqual(1);
  // voltar um passo pede confirmação; cancelar não muda nada
  await r.getByRole('button', { name: 'Voltar para enviado' }).click();
  await expect(r).toContainText('apaga a data de entrega');
  await r.getByRole('button', { name: 'Cancelar' }).click();
  await expect(r.locator('.pill')).toContainText('Entregue');
  expect((await db.doc(`users/${a.uid}/private/medal`).get()).data().status).toBe('delivered');
  await r.getByRole('button', { name: 'Voltar para enviado' }).click();
  await r.getByRole('button', { name: 'Voltar o passo' }).click();
  await expect(r.locator('.pill')).toContainText('Enviado');
  await r.getByRole('button', { name: 'Voltar para pago' }).click();
  await expect(r).toContainText('apaga o código de rastreio');
  await r.getByRole('button', { name: 'Cancelar' }).click();
  await expect(r.locator('.pill')).toContainText('Enviado');
  expect((await db.doc(`users/${a.uid}/private/medal`).get()).data().trackingCode).toBe('BR123456789XX');
  await r.getByRole('button', { name: 'Voltar para pago' }).click();
  await r.getByRole('button', { name: 'Voltar o passo' }).click();
  await expect(r.locator('.pill')).toContainText('Pago, aguardando envio');
  await expect(r).not.toContainText('BR123456789XX');
  expect(await mcount(page, 'paid')).toBe(paid0);
});

test('medalhas: enviado sem e-mail mostra o aviso e Reenviar e-mail resolve; falha do envio aparece', async ({ page }) => {
  const a = await concludedAthlete('Otávia Sem Email', {
    status: 'shipped', checkoutId: 'ck-med-2', paidAt: new Date(), trackingCode: 'BR000111222', shippedAt: '2026-11-01',
  });
  await coachPanel(page, 'Medalhas');
  const r = mrow(page, 'Otávia Sem Email');
  await expect(r.locator('[data-mail="no"]')).toContainText('E-mail não enviado');
  await db.doc('testFaults/mail').set({ fail: true });
  try {
    await r.getByRole('button', { name: 'Reenviar e-mail' }).click();
    await expect(r.getByRole('alert')).toContainText('e-mail não saiu');
    await expect(r.locator('[data-mail="no"]')).toBeVisible();
  } finally {
    await db.doc('testFaults/mail').delete();
  }
  await r.getByRole('button', { name: 'Reenviar e-mail' }).click();
  await expect(r.locator('[data-mail="ok"]')).toBeVisible();
  expect((await db.doc(`users/${a.uid}/private/medal`).get()).data().emailedCount).toBe(1);
});

test('medalhas: filtro, busca, marca de reembolso e alertas medal-*', async ({ page }) => {
  await concludedAthlete('Paula Filtro Pago', { status: 'paid', checkoutId: 'ck-f1', paidAt: new Date(), refundRequestedAt: new Date(), refundCount: 1 });
  const ent = await concludedAthlete('Eduardo Filtro Entregue', { status: 'delivered', checkoutId: 'ck-f2', paidAt: new Date(), trackingCode: 'BR999888777', shippedAt: '2026-11-02', deliveredAt: '2026-11-09', emailedAt: new Date(), emailedCount: 1 });
  await concludedAthlete('Rita Filtro Reembolsada', { status: 'refunded', checkoutId: 'ck-f3', refundCount: 1 });
  await db.collection('alerts').add({ type: 'medal-refunded-shipped', uid: ent.uid, at: new Date(), resolved: false });
  await db.collection('alerts').add({ type: 'medal-partial-refund', uid: ent.uid, at: new Date(), resolved: false });
  await db.collection('alerts').add({ type: 'medal-email-failed', uid: ent.uid, at: new Date(), resolved: false });
  await coachPanel(page, 'Medalhas');
  const chips = page.getByRole('group', { name: 'Situação da medalha' });
  await expect(mrow(page, 'Paula Filtro Pago')).toContainText('Pediu reembolso');
  await expect(mrow(page, 'Paula Filtro Pago')).toContainText('Reembolsos: 1');
  await expect(mrow(page, 'Eduardo Filtro Entregue')).toContainText('Entregue em 09/11/2026');
  await expect(page.getByRole('alert').filter({ hasText: 'Atenção' })).toContainText('Medalha reembolsada depois de enviada');
  await expect(page.getByRole('alert').filter({ hasText: 'Atenção' })).toContainText('Reembolso parcial da medalha');
  await expect(page.getByRole('alert').filter({ hasText: 'Atenção' })).toContainText('e-mail de envio da medalha não saiu');

  await chips.getByRole('button', { name: /^Reembolsado/ }).click();
  await expect(page.locator('tr[data-medal]').filter({ hasText: 'Rita Filtro Reembolsada' })).toHaveCount(1);
  await expect(page.locator('tr[data-medal]').filter({ hasText: 'Paula Filtro Pago' })).toHaveCount(0);
  await chips.getByRole('button', { name: /^Todas/ }).click();
  await page.getByLabel('Buscar por nome').fill('eduardo filtro');
  await expect(page.locator('tr[data-medal]')).toHaveCount(1);
  await expect(page.locator('tr[data-medal]')).toContainText('Eduardo Filtro Entregue');
  await page.getByLabel('Buscar por nome').fill('zzzz-ninguem');
  await expect(page.getByText('Nenhum aluno encontrado com esse filtro.')).toBeVisible();
});

test('medalhas: tabela rola dentro do cartão em 390 px, sem scroll horizontal na página', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await concludedAthlete('Larissa Mobile', { status: 'paid', checkoutId: 'ck-m1', paidAt: new Date() });
  await coachPanel(page, 'Medalhas');
  await expect(mrow(page, 'Larissa Mobile')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('venda de medalha aparece como Medalha e fica fora de receita e ticket médio; Atletas marca o pedido de reembolso', async ({ page }) => {
  await db.recursiveDelete(db.collection('payments'));
  const a = await makeAthlete({ name: 'Ana Programa' });
  const b = await makeAthlete({ name: 'Beto Reembolso' });
  await db.doc(`users/${a.uid}/private/profile`).set({ email: a.email, cpf: '12345678909', phone: '', policyAcceptedAt: new Date() });
  await db.doc(`users/${a.uid}/private/billing`).set({ status: 'paid', method: 'PIX', installments: 1 });
  await db.doc(`users/${b.uid}/private/profile`).set({ email: b.email, cpf: '98765432100', phone: '', policyAcceptedAt: new Date() });
  await db.doc(`users/${b.uid}/private/billing`).set({ status: 'paid', method: 'PIX', installments: 1, refundRequestedAt: new Date(), refundCount: 1 });
  const now = new Date();
  await db.doc('payments/ck-prog').set({ uid: a.uid, checkoutId: 'ck-prog', status: 'paid', method: 'PIX', gross: 159, net: 157.01, product: 'Do 0 aos 5 km', kind: 'program', paidAt: now, updatedAt: now });
  await db.doc('payments/ck-medal').set({ uid: a.uid, checkoutId: 'ck-medal', status: 'paid', method: 'PIX', gross: 35, net: 34.01, product: 'Medalha Letz bora!', kind: 'medal', paidAt: now, updatedAt: now });
  await coachPanel(page);
  const kpi = (n) => page.locator(`[data-kpi="${n}"]`);
  await expect(kpi('liquida')).toContainText('R$ 157,01');
  await expect(kpi('aprovadas').locator('b')).toHaveText('1');
  await expect(kpi('aprovadas')).toContainText('Ticket médio R$ 157,01');
  await expect(page.locator('[data-medal-sales]')).toContainText('1 venda aprovada · R$ 34,01 líquido');
  await page.getByRole('group', { name: 'Financeiro' }).getByRole('button', { name: 'Vendas' }).click();
  const med = page.locator('table[data-fin="vendas"] tbody tr', { hasText: 'R$ 35,00' });
  await expect(med).toHaveCount(1);
  await expect(med).toContainText('Medalha');
  await expect(med).not.toContainText('Letz bora');

  await page.getByRole('group', { name: 'Seções' }).getByRole('button', { name: 'Atletas' }).click();
  const br = row(page, 'Beto Reembolso');
  await expect(br.locator('[data-refund-ask]')).toContainText('Pediu reembolso');
  await expect(br).toContainText('Reembolsos: 1');
  await expect(row(page, 'Ana Programa').locator('[data-refund-ask]')).toHaveCount(0);
});
