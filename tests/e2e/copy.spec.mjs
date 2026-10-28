// Textos de lançamento: as telas públicas e de entrada não podem citar a Kiwify,
// o código de acesso nem restos de versão de teste.
import { test, expect } from '@playwright/test';

const ROTAS = ['#/', '#/privacidade', '#/cadastro', '#/entrar', '#/instalar'];
const PROIBIDOS = [/\bKiwify\b/i, /c[óo]digo de acesso/i, /\bSimular\b/i, /\bteste\b/i, /12x de R\$ 16,44/];

for (const rota of ROTAS) {
  test(`textos de lançamento em ${rota}`, async ({ page }) => {
    await page.goto('/' + rota);
    await page.waitForLoadState('networkidle');
    const texto = await page.locator('body').innerText();
    expect(texto.length).toBeGreaterThan(50);
    for (const re of PROIBIDOS) expect(texto, String(re)).not.toMatch(re);
  });
}

test('oferta mostra Asaas e parcelamento sem juros', async ({ page }) => {
  await page.goto('/');
  const texto = await page.locator('body').innerText();
  expect(texto).toContain('Pagamento seguro pelo Asaas · Pix ou cartão');
  expect(texto).toContain('12x de R$ 13,25 sem juros');
});

test('privacidade menciona Asaas, cadastro e conta com senha', async ({ page }) => {
  await page.goto('/#/privacidade');
  const texto = await page.locator('body').innerText();
  expect(texto.toLowerCase()).toContain('atualizada em 28 de outubro de 2026');
  expect(texto).toContain('nome, e-mail, CPF e celular informados no cadastro');
  expect(texto).toContain('e-mail e senha da sua conta');
  expect(texto).toContain('Asaas, que processa os pagamentos (Pix e cartão)');
});
