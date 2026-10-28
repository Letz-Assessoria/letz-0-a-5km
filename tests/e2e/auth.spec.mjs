// e2e de conta: cadastro → Asaas (falso) → webhook → app, login, telas de
// pendente/bloqueado, guarda de rotas e textos das telas de entrada.
import { test, expect } from '@playwright/test';
import {
  auth, callable, checkoutPaid, clearRateLimits, fillAddress, makeCoach, makeUser, mockViaCep, person, webhookToken, FAKE, WEBHOOK,
} from './helpers.mjs';

const CHECKOUT_URL = /^http:\/\/127\.0\.0\.1:7777\/checkoutSession\/show\/[^/]+$/;

let pageErrors = [];
test.beforeEach(async ({ page }) => {
  await clearRateLimits();
  pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
});
test.afterEach(() => {
  expect(pageErrors, 'erros de JavaScript na página').toEqual([]);
});

async function login(page, email, password) {
  await page.goto('/#/entrar');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

test('cadastro → checkout fake → webhook pago → app', async ({ page }) => {
  const p = person();
  await mockViaCep(page);
  await page.goto('/');
  await page.locator('[data-act="buy"]').first().click();
  await expect(page).toHaveURL(/#\/cadastro$/);

  await page.getByLabel('Nome completo').fill(p.name);
  await page.getByLabel('E-mail').fill(p.email);
  await page.getByLabel('CPF').fill(p.cpf);
  await page.getByLabel('Celular com DDD').fill(p.phone);
  await fillAddress(page, p);
  await page.getByLabel('Senha', { exact: true }).fill(p.password);
  await page.getByLabel('Confirme a senha').fill(p.password);
  await page.getByLabel(/Li e aceito a política de privacidade/).check();
  await page.getByRole('button', { name: /Criar conta e ir para o pagamento/ }).click();

  await page.waitForURL(CHECKOUT_URL);
  const checkoutId = page.url().split('/').pop();
  const user = await auth.getUserByEmail(p.email);

  // Volta do Asaas antes de o aviso chegar: "Confirmando seu pagamento…".
  await page.goto('/#/confirmando');
  await expect(page.getByText('Confirmando seu pagamento…')).toBeVisible();

  const r = await fetch(`${FAKE}/__emit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: WEBHOOK, token: webhookToken(), body: checkoutPaid(user.uid, checkoutId) }),
  });
  expect((await r.json()).status).toBe(200);

  // A tela muda sozinha quando users/{uid}.access vira active.
  await expect(page).toHaveURL(/#\/perfil$/);
  await expect(page.getByRole('heading', { name: /Quem é/ })).toBeVisible();
});

test('cadastro com o Asaas fora do ar entra e mostra Concluir pagamento', async ({ page }) => {
  const p = person();
  await fetch(`${FAKE}/__fail`, { method: 'POST', body: JSON.stringify({ checkouts: true }) });
  try {
    await mockViaCep(page);
    await page.goto('/#/cadastro');
    await page.getByLabel('Nome completo').fill(p.name);
    await page.getByLabel('E-mail').fill(p.email);
    await page.getByLabel('CPF').fill(p.cpf);
    await page.getByLabel('Celular com DDD').fill(p.phone);
    await fillAddress(page, p);
    await page.getByLabel('Senha', { exact: true }).fill(p.password);
    await page.getByLabel('Confirme a senha').fill(p.password);
    await page.getByLabel(/Li e aceito a política de privacidade/).check();
    await page.getByRole('button', { name: /Criar conta e ir para o pagamento/ }).click();

    await expect(page).toHaveURL(/#\/aguardando$/);
    await expect(page.getByRole('alert')).toContainText('Não conseguimos abrir o pagamento agora.');
  } finally {
    await fetch(`${FAKE}/__fail`, { method: 'POST', body: JSON.stringify({ checkouts: false }) });
  }
  await page.getByRole('button', { name: 'Concluir pagamento' }).click();
  await page.waitForURL(CHECKOUT_URL);
});

test('pendente que entra vê aguardando e Concluir pagamento', async ({ page }) => {
  const p = person();
  const res = await callable('signup', { ...p, acceptPolicy: true });
  expect(res.result && res.result.checkoutUrl).toMatch(CHECKOUT_URL);

  await login(page, p.email, p.password);
  await expect(page).toHaveURL(/#\/aguardando$/);
  await expect(page.getByRole('heading', { name: /Aguardando/ })).toBeVisible();
  await expect(page.getByText('letzassessoria@gmail.com')).toBeVisible();
  await expect(page.locator('a[href^="https://wa.me/558781908719"]')).toBeVisible();

  await page.getByRole('button', { name: 'Concluir pagamento' }).click();
  await page.waitForURL(CHECKOUT_URL);
});

test('bloqueado vê tela de bloqueio', async ({ page }) => {
  const u = await makeUser('blocked');
  await login(page, u.email, u.password);
  await expect(page).toHaveURL(/#\/bloqueado$/);
  await expect(page.getByRole('heading', { name: /bloqueado/ })).toBeVisible();
  await expect(page.getByText('letzassessoria@gmail.com')).toBeVisible();
  await expect(page.locator('a[href^="https://wa.me/558781908719"]')).toBeVisible();

  // Rota do app também cai no bloqueio.
  await page.goto('/#/app/feed');
  await expect(page).toHaveURL(/#\/bloqueado$/);
});

test('link direto #/app/feed sem login vai para #/entrar', async ({ page }) => {
  await page.goto('/#/app/feed');
  await expect(page).toHaveURL(/#\/entrar$/);
  await expect(page.getByLabel('Senha', { exact: true })).toBeVisible();

  await page.goto('/#/admin/turma');
  await expect(page).toHaveURL(/#\/entrar$/);
});

test('treinador entra e vê o painel', async ({ page }) => {
  const c = await makeCoach();
  await login(page, c.email, c.password);
  await expect(page).toHaveURL(/#\/admin\/financeiro$/);
  await expect(page.getByRole('heading', { name: 'Painel' })).toBeVisible();

  // Sair encerra a sessão e protege o painel de novo.
  await page.getByRole('button', { name: 'Sair' }).click();
  await expect(page).toHaveURL(/#\/entrar$/);
  await page.goto('/#/admin/turma');
  await expect(page).toHaveURL(/#\/entrar$/);
});

test('senha errada mostra mensagem em português', async ({ page }) => {
  const u = await makeUser('active');
  await login(page, u.email, 'senha-errada-999');
  await expect(page.getByRole('alert')).toHaveText('E-mail ou senha incorretos.');
  await expect(page).toHaveURL(/#\/entrar$/);

  // Com a senha certa, o aluno ativo entra (primeiro acesso → perfil).
  await page.getByLabel('Senha', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/#\/perfil$/);
});

test('não existe texto "Kiwify", "teste" ou "Simular" nas telas de entrada', async ({ page }) => {
  for (const route of ['/#/entrar', '/#/cadastro', '/#/esqueci']) {
    await page.goto(route);
    await expect(page.locator('#app form')).toBeVisible();
    const text = await page.locator('#app').innerText();
    expect(text, route).not.toMatch(/kiwify|\bteste\b|simular|código de acesso/i);
  }
});

test('cadastro: endereço aparece por etapas e aceita CEP não encontrado', async ({ page }) => {
  await mockViaCep(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/cadastro');
  // De início só o CEP: nada de rua, bairro, número.
  await expect(page.getByLabel('CEP')).toBeVisible();
  await expect(page.getByLabel('Número')).toHaveCount(0);
  await expect(page.getByLabel('Rua ou avenida')).toHaveCount(0);

  // CEP achado: uma linha de conferência e só o número a preencher.
  await page.getByLabel('CEP').fill('50050000');
  await expect(page.getByLabel('Número')).toBeVisible();
  await expect(page.getByLabel('Número')).toBeFocused();
  await expect(page.locator('.addrline')).toContainText('Rua da Aurora · Boa Vista · Recife/PE');
  await expect(page.getByLabel('Rua ou avenida')).toHaveCount(0);
  await expect(page.getByLabel('CEP')).toHaveValue('50050-000');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('#f-signup').screenshot({ path: 'test-results/cadastro-endereco-390.png' });

  // "Corrigir" abre os campos completos, já preenchidos.
  await page.getByRole('button', { name: 'Corrigir' }).click();
  await expect(page.getByLabel('Rua ou avenida')).toHaveValue('Rua da Aurora');
  await expect(page.getByLabel('Bairro')).toHaveValue('Boa Vista');

  // CEP que o ViaCEP não conhece: campos completos vazios para preencher à mão.
  await page.getByLabel('CEP').fill('00000000');
  await expect(page.getByText(/CEP não encontrado/)).toBeVisible();
  await expect(page.getByLabel('Rua ou avenida')).toBeVisible();

  // Sem número, o envio para antes de chamar o servidor.
  await page.getByLabel('Nome completo').fill('Aluna Teste');
  await page.getByRole('button', { name: /Criar conta e ir para o pagamento/ }).click();
  await expect(page.getByRole('alert')).toBeVisible();
});
