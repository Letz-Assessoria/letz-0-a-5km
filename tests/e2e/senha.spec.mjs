// e2e da senha nova: pede o link em "Esqueci minha senha", abre o link do e-mail, troca a senha e entra.
import { test, expect } from '@playwright/test';
import { clearRateLimits, db, makeUser, waitUntil, skipGuide } from './helpers.mjs';

test('esqueci a senha: link do e-mail troca a senha e o login funciona; o link não vale duas vezes', async ({ page }) => {
  await skipGuide(page);
  await clearRateLimits();
  await db.doc('testMail/last').delete().catch(() => {});
  const u = await makeUser('active', { profiled: true, handle: 'senha' + Date.now() % 1e6 });
  await page.goto('/#/esqueci');
  await page.getByLabel('E-mail').fill(u.email);
  await page.getByRole('button', { name: /enviar/i }).click();
  await expect(page.getByText('o link chega em alguns minutos')).toBeVisible();
  const mail = await waitUntil(async () => {
    const m = (await db.doc('testMail/last').get()).data();
    return m && m.to === u.email ? m : null;
  });
  const link = mail.text.match(/https?:\/\/\S+#\/redefinir\/[A-Za-z0-9_-]+/)[0];
  const path = '/#' + link.split('#')[1];

  await page.goto(path);
  await page.getByLabel('Senha nova').fill('nova-senha-77');
  await page.getByLabel('Repita a senha').fill('outra-coisa-1');
  await page.getByRole('button', { name: /salvar senha/i }).click();
  await expect(page.getByText('As senhas não são iguais.')).toBeVisible();
  await page.getByLabel('Senha nova').fill('nova-senha-77');
  await page.getByLabel('Repita a senha').fill('nova-senha-77');
  await page.getByRole('button', { name: /salvar senha/i }).click();
  await expect(page.getByText('Sua senha foi trocada')).toBeVisible();

  await page.getByRole('button', { name: /^entrar/i }).click();
  await expect(page.getByLabel('E-mail')).toHaveValue(u.email);
  await page.getByLabel('Senha').fill('nova-senha-77');
  await page.getByRole('button', { name: /^entrar/i }).click();
  await expect(page).toHaveURL(/#\/(app|boas-vindas)/);

  await page.goto(path);
  await page.reload();
  await page.getByLabel('Senha nova').fill('terceira-senha-5');
  await page.getByLabel('Repita a senha').fill('terceira-senha-5');
  await page.getByRole('button', { name: /salvar senha/i }).click();
  await expect(page.getByText('Este link venceu ou já foi usado')).toBeVisible();
});
