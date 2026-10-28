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
  expect(texto).toContain('nome, e-mail, CPF, celular e endereço informados no cadastro');
  expect(texto).toContain('e-mail e senha da sua conta');
  expect(texto).toContain('Asaas, que processa os pagamentos (Pix e cartão)');
});

test('medalha: R$ 35,00 de frete pago no fim, Pix ou cartão à vista, sem restos do fluxo antigo', async ({ page }) => {
  await page.goto('/');
  const texto = await page.locator('body').innerText();
  expect(texto).toContain('frete de R$ 35,00, pago ao concluir');
  expect(texto).toContain('só é pago no fim');
  expect(texto).toContain('Pix ou no cartão (à vista)');
  for (const re of [/frete à parte/i, /cobrado à parte/i, /Pix manual/i, /\bQR\b/i, /chave Pix/i]) {
    expect(texto, String(re)).not.toMatch(re);
  }
});

test('FAQ: reembolso do programa, da medalha e recompra batem com o fluxo', async ({ page }) => {
  await page.goto('/');
  const texto = await page.locator('body').innerText();
  expect(texto).toContain('Você tem 7 dias a partir da compra do programa');
  expect(texto).toContain('pelo WhatsApp da assessoria');
  expect(texto).toContain('só antes de ser enviada');
  expect(texto).toContain('comprar de novo uma vez');
  expect(texto).toContain('código de rastreio no app e por e-mail');
});

test('privacidade: endereço de entrega, e-mail de envio e prazo de guarda', async ({ page }) => {
  await page.goto('/#/privacidade');
  const texto = await page.locator('body').innerText();
  expect(texto).toContain('endereço de entrega, com CEP');
  expect(texto).toContain('a partir de letzassessoria@gmail.com');
  expect(texto).toContain('até a medalha ser entregue e por mais 90 dias');
  expect(texto).toContain('processados pelo Asaas (Pix e cartão)');
  expect(texto).not.toMatch(/frete por Pix|Pix manual|\bQR\b/i);
});
