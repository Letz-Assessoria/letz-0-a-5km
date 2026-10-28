// e2e de parceiros e cupons de desconto: o treinador cria parceiro + cupom, um aluno se
// cadastra com o cupom e paga com desconto no Asaas falso, e o painel mostra a conversão.
import { test, expect } from '@playwright/test';
import {
  admin, auth, checkoutPaid, clearRateLimits, db, fillAddress, makeCoach, mockViaCep, person, webhookToken, waitUntil, FAKE, WEBHOOK,
  skipGuide,
} from './helpers.mjs';

const CHECKOUT_URL = /^http:\/\/127\.0\.0\.1:7777\/checkoutSession\/show\/[^/]+$/;
let pageErrors = [];
test.beforeEach(async () => { await clearRateLimits(); pageErrors = []; });
test.afterEach(() => { expect(pageErrors, 'erros de JavaScript na página').toEqual([]); });

async function login(page, u) {
  await skipGuide(page);
  await page.goto('/#/entrar');
  await page.getByLabel('E-mail').fill(u.email);
  await page.getByLabel('Senha', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

async function openPartners(page) {
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  const c = await makeCoach();
  await login(page, c);
  await expect(page).toHaveURL(/#\/admin\//);
  await page.getByRole('group', { name: 'Seções' }).getByRole('button', { name: 'Parceiros' }).click();
  await expect(page).toHaveURL(/#\/admin\/parceiros$/);
  return c;
}

async function createPartnerOnPanel(page, code, extra = {}) {
  const name = 'Parceira Maria ' + code;
  const f = page.locator('#f-partner');
  await f.getByLabel('Nome do parceiro').fill(name);
  await f.getByLabel('E-mail', { exact: true }).fill(`parceira-${code.toLowerCase()}@exemplo.com`);
  await f.getByLabel('Código do cupom').fill(code);
  if (extra.pct) await f.getByLabel('Desconto (%)').fill(extra.pct);
  await f.getByRole('button', { name: 'Cadastrar parceiro e criar cupom' }).click();
  return name;
}

async function signupWithCoupon(browser, code, { expectCheckout = true } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  const p = person();
  await mockViaCep(page);
  await page.goto('/#/cadastro');
  await page.getByLabel('Nome completo').fill(p.name);
  await page.getByLabel('E-mail').fill(p.email);
  await page.getByLabel('CPF').fill(p.cpf);
  await page.getByLabel('Celular com DDD').fill(p.phone);
  await fillAddress(page, p);
  await page.getByRole('button', { name: 'Tenho um cupom' }).click();
  await page.getByLabel('Código do cupom').fill(code.toLowerCase());
  await expect(page.getByLabel('Código do cupom')).toHaveValue(code);
  await page.getByLabel('Senha', { exact: true }).fill(p.password);
  await page.getByLabel('Confirme a senha').fill(p.password);
  await page.getByLabel(/Li e aceito a política de privacidade/).check();
  await page.getByRole('button', { name: /Criar conta e ir para o pagamento/ }).click();
  if (expectCheckout) await page.waitForURL(CHECKOUT_URL);
  return { ctx, page, p };
}

test('treinador cria parceiro com 5%, aluno paga com desconto e o painel mostra a conversão', async ({ page, browser }) => {
  const code = 'MARIA' + Date.now().toString().slice(-6);
  await openPartners(page);
  const name = await createPartnerOnPanel(page, code);

  const res = page.locator('[data-pfres]');
  await expect(res).toContainText('Parceiro criado');
  const link = await res.getByLabel('Link de criação de senha').inputValue();
  expect(link).toMatch(/oobCode=/);
  const card = page.locator('[data-partner]', { hasText: name });
  await expect(card).toContainText(code);
  await expect(card).toContainText('5% de desconto');
  const partner = (await db.doc('coupons/' + code).get()).data();
  const pu = (await db.doc('users/' + partner.partnerUid).get()).data();
  expect(pu.access).toBe('active');
  await expect(page.locator('tr', { hasText: name })).toHaveCount(0);

  // O aluno se cadastra com o cupom e cai no checkout do Asaas falso com o valor reduzido.
  const { ctx, page: sp, p } = await signupWithCoupon(browser, code);
  const user = await auth.getUserByEmail(p.email);
  const checkoutId = sp.url().split('/').pop();
  const sent = (await (await fetch(`${FAKE}/__checkouts`)).json()).find((c) => c.externalReference === user.uid);
  expect(sent.items[0].value).toBe(151.05);
  await waitUntil(async () => (await db.doc(`coupons/${code}/uses/${user.uid}`).get()).exists);
  await expect(card.locator('[data-coupon]')).toContainText('1/1000 cadastros');

  // Pagamento confirmado: vira conversão.
  const hook = await fetch(WEBHOOK, {
    method: 'POST', headers: { 'content-type': 'application/json', 'asaas-access-token': webhookToken() },
    body: JSON.stringify(checkoutPaid(user.uid, checkoutId)),
  });
  expect(hook.status).toBe(200);
  await waitUntil(async () => (await db.doc(`coupons/${code}`).get()).data().convertedCount === 1);
  await card.getByRole('button', { name: 'Ver usos' }).click();
  const uses = card.locator(`table[data-uses="${code}"]`);
  await expect(uses).toContainText(p.name);
  await expect(uses).toContainText('Pagou');
  const conv = (await db.doc(`coupons/${code}/uses/${user.uid}`).get()).data();
  expect(conv.status).toBe('converted');
  // Data e hora de pagamento no fuso de Brasília.
  const when = new Date(conv.convertedAt.toMillis()).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  await expect(uses).toContainText(when);
  await expect(card.locator('.kpi', { hasText: 'Pagaram' })).toContainText('1');
  await expect(card.locator('.kpi', { hasText: 'Hoje' })).toContainText('1');
  await expect(card.locator('.kpi', { hasText: 'Últimos 7 dias' })).toContainText('1');
  await expect(card.locator('.kpi', { hasText: 'Pagaram' })).toContainText('Taxa 100%');
  await ctx.close();
});

test('cupom esgotado e cupom desativado no painel impedem o uso', async ({ page, browser }) => {
  const code = 'LIMITE' + Date.now().toString().slice(-6);
  await openPartners(page);
  const name = await createPartnerOnPanel(page, code, { pct: '10' });
  const card = page.locator('[data-partner]', { hasText: name });
  await expect(card).toContainText('10% de desconto');

  // Limite de 1 cadastro pelo painel.
  await card.getByLabel('Limite de cadastros').fill('1');
  await card.getByLabel('Limite de cadastros').blur();
  await waitUntil(async () => (await db.doc('coupons/' + code).get()).data().maxUses === 1);
  const first = await signupWithCoupon(browser, code);
  const u1 = await auth.getUserByEmail(first.p.email);
  expect((await db.doc(`users/${u1.uid}/private/billing`).get()).data().value).toBe(143.1);
  await first.ctx.close();

  const second = await signupWithCoupon(browser, code, { expectCheckout: false });
  await expect(second.page.getByRole('alert')).toContainText('Cupom inválido ou esgotado.');
  await second.ctx.close();

  // Desativar no painel (o limite sobe para liberar o teste de "inativo").
  await card.getByLabel('Limite de cadastros').fill('');
  await card.getByLabel('Limite de cadastros').blur();
  await waitUntil(async () => (await db.doc('coupons/' + code).get()).data().maxUses === null);
  await card.getByLabel('Ativo').uncheck();
  await waitUntil(async () => (await db.doc('coupons/' + code).get()).data().active === false);
  const third = await signupWithCoupon(browser, code, { expectCheckout: false });
  await expect(third.page.getByRole('alert')).toContainText('Cupom inválido ou esgotado.');
  await third.ctx.close();
});

test('novo cupom para o mesmo parceiro aparece agrupado na lista', async ({ page }) => {
  const code = 'GRUPO' + Date.now().toString().slice(-6);
  await openPartners(page);
  const name = await createPartnerOnPanel(page, code);
  const card = page.locator('[data-partner]', { hasText: name });
  await card.getByRole('button', { name: 'Novo cupom' }).click();
  const second = 'OUTRO' + Date.now().toString().slice(-6);
  await card.locator('#f-coupon').getByLabel('Código do cupom').fill(second);
  await card.locator('#f-coupon').getByLabel('Desconto (%)').fill('7');
  await card.getByRole('button', { name: 'Criar cupom' }).click();
  await expect(card.locator(`[data-coupon="${second}"]`)).toContainText('7% de desconto');
  await expect(card.locator('[data-coupon]')).toHaveCount(2);

  // O parceiro aparece em Atletas como cortesia, nunca como pendente.
  await page.getByRole('group', { name: 'Seções' }).getByRole('button', { name: 'Atletas' }).click();
  const r = page.locator('tr', { hasText: `parceira-${code.toLowerCase()}@exemplo.com` });
  await expect(r).toContainText('Cortesia · parceiro');
  await expect(r).not.toContainText('Pendente');
});

test('cadastro: link "Tenho um cupom" em 390px, sem rolagem horizontal e sem esconder o endereço', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await mockViaCep(page);
  await page.goto('/#/cadastro');
  const link = page.getByRole('button', { name: 'Tenho um cupom' });
  await expect(link).toBeVisible();
  const noScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await noScroll()).toBe(true);
  await page.getByLabel('CEP').fill('50050-000');
  await link.click();
  await page.getByLabel('Código do cupom').fill('abc123');
  await expect(page.getByLabel('Código do cupom')).toHaveValue('ABC123');
  await expect(page.getByLabel('CEP')).toBeVisible();
  await expect(page.getByLabel('Número')).toBeVisible();
  expect(await noScroll()).toBe(true);
  await ctx.close();
});

test('painel conta conversões de hoje, dos últimos 7 dias e total pela data de pagamento', async ({ page }) => {
  const code = 'PERIOD' + Date.now().toString().slice(-6);
  const T = (ms) => admin.firestore.Timestamp.fromMillis(ms);
  const now = Date.now();
  await db.doc('coupons/' + code).set({
    code, partnerUid: 'seed' + code, partnerName: 'Parceiro Período ' + code, active: true, percent: 5, maxUses: null,
    usedCount: 4, convertedCount: 3, expiresAt: null, createdAt: T(now),
  });
  const use = (uid, status, daysAgo) => db.doc(`coupons/${code}/uses/${uid}`).set({
    name: 'Pessoa ' + uid, partnerUid: 'seed' + code, at: T(now - (daysAgo + 1) * 864e5), status,
    ...(status === 'converted' ? { convertedAt: T(now - daysAgo * 864e5 - 60000), value: 151.05 } : {}),
  });
  await use('u1', 'converted', 0);
  await use('u2', 'converted', 3);
  await use('u3', 'converted', 20);
  await use('u4', 'signed-up', 0);
  await openPartners(page);
  const card = page.locator('[data-partner]', { hasText: code });
  await expect(card.locator('.kpi', { hasText: 'Cadastros' })).toContainText('4');
  await expect(card.locator('.kpi', { hasText: 'Pagaram' })).toContainText('3');
  await expect(card.locator('.kpi', { hasText: 'Pagaram' })).toContainText('Taxa 75%');
  await expect(card.locator('.kpi', { hasText: 'Hoje' })).toContainText('1');
  await expect(card.locator('.kpi', { hasText: 'Últimos 7 dias' })).toContainText('2');
  await card.getByRole('button', { name: 'Ver usos' }).click();
  const rows = card.locator(`table[data-uses="${code}"] tbody tr`);
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('Pessoa u1');
  await expect(card.locator(`table[data-uses="${code}"]`)).toContainText('Cadastrou');
});
