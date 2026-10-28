// e2e do painel do treinador: acesso, bloqueio, moderação, data da turma e vendas.
import { test, expect } from '@playwright/test';
import {
  admin, auth, clearRateLimits, db, fillAddress, makeAthlete, makeCoach, makeUser, mockViaCep, person, resetStart, setStart,
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
