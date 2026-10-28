// e2e do aluno: perfil, treinos, feed, ranking, fotos, reações, comentários e a medalha (modal, endereço, pagamento, status e reembolso).
import { test, expect } from '@playwright/test';
import {
  admin, auth, callable, checkoutPaid, clearRateLimits, db, emitMedalPaid, FAKE, makeAthlete, makeCoach, makeUser, mockViaCep, person,
  resetStart, seedConcluded, setStart, storageObject, uniqueHandle, waitUntil, webhookToken, WEBHOOK,
  skipGuide,
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

async function login(page, u, hash = '#/entrar') {
  await skipGuide(page);
  await page.goto('/' + hash);
  await page.getByLabel('E-mail').fill(u.email);
  await page.getByLabel('Senha', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
}

async function tab(page, name) {
  await page.getByRole('navigation', { name: 'Principal' }).getByRole('button', { name }).click();
}

// JPEG gerado no navegador (w x h) para enviar por setInputFiles.
async function jpeg(page, w, h) {
  const b64 = await page.evaluate(async ([cw, ch]) => {
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, cw, ch);
    g.addColorStop(0, '#e85d04'); g.addColorStop(1, '#023e8a');
    x.fillStyle = g; x.fillRect(0, 0, cw, ch);
    for (let i = 0; i < 400; i++) {
      x.fillStyle = `rgb(${(i * 37) % 255},${(i * 91) % 255},${(i * 53) % 255})`;
      x.fillRect((i * 97) % cw, (i * 61) % ch, 120, 90);
    }
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, [w, h]);
  return { name: 'foto.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') };
}

test('perfil com foto salva e aparece no feed de outro aluno', async ({ page, browser }) => {
  const a = await makeUser('active');
  const handle = uniqueHandle();
  await login(page, a);
  await expect(page).toHaveURL(/#\/perfil$/);
  await page.locator('#in-photo').setInputFiles(await jpeg(page, 600, 400));
  await page.getByLabel('Seu @').fill(handle);
  await page.getByRole('button', { name: /Salvar e continuar/ }).click();
  await expect(page.getByRole('button', { name: /Ok, vamos começar/ })).toBeVisible();

  const u = await waitUntil(async () => {
    const d = (await db.doc('users/' + a.uid).get()).data();
    return d.profiled && d.photoURL ? d : null;
  });
  expect(u.handle).toBe(handle);
  expect(u.photoURL).toMatch(/avatars/);
  expect((await db.doc('handles/' + handle).get()).data().uid).toBe(a.uid);
  expect((await storageObject(`avatars/${a.uid}.jpg`)).contentType).toBe('image/jpeg');

  await page.getByRole('button', { name: /Ok, vamos começar/ }).click();
  await page.getByRole('button', { name: /Marcar como feito/ }).first().click();
  await expect(page.getByText('Feito', { exact: true }).first()).toBeVisible();

  // Outro aluno, outro navegador: vê o post de A com a foto do perfil.
  const b = await makeAthlete();
  const ctx = await browser.newContext();
  const pb = await ctx.newPage();
  await login(pb, b);
  await expect(pb).toHaveURL(/#\/app\/treinos$/);
  await tab(pb, 'Feed');
  const post = pb.locator('.post', { hasText: '@' + handle });
  await expect(post).toBeVisible();
  await expect(post.locator('.av img')).toHaveAttribute('src', /avatars/);
  await ctx.close();
});

test('handle repetido mostra erro', async ({ page }) => {
  const taken = await makeAthlete();
  const a = await makeUser('active');
  await login(page, a);
  await expect(page).toHaveURL(/#\/perfil$/);
  await page.getByLabel('Seu @').fill(taken.handle);
  await page.getByRole('button', { name: /Salvar e continuar/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: /já está em uso/ })).toBeVisible();
  expect((await db.doc('users/' + a.uid).get()).data().profiled).toBe(false);
});

test('marcar treino aparece no feed e soma 3 pontos no ranking', async ({ page }) => {
  const a = await makeAthlete();
  await login(page, a);
  await expect(page).toHaveURL(/#\/app\/treinos$/);
  await page.getByRole('button', { name: /Marcar como feito/ }).first().click();
  await expect(page.getByText('Feito', { exact: true }).first()).toBeVisible();

  await tab(page, 'Feed');
  await expect(page.locator('.post', { hasText: '@' + a.handle })).toContainText('treino de terça da semana 1');
  await expect(page.getByText('exemplo')).toHaveCount(0);

  await waitUntil(async () => (await db.doc('users/' + a.uid).get()).data().points === 3);
  await tab(page, 'Ranking');
  await expect(page.locator('.rank', { hasText: '@' + a.handle })).toContainText('3 pts');
});

test('semana trancada não deixa marcar', async ({ page }) => {
  const a = await makeAthlete();
  await login(page, a);
  await expect(page).toHaveURL(/#\/app\/treinos$/);
  await page.getByRole('button', { name: /Semana 2, trancada/ }).click();
  await expect(page.getByText('Ainda trancada')).toBeVisible();
  await expect(page.getByRole('button', { name: /Marcar como feito/ })).toHaveCount(0);
  // Mesmo chamando direto, as regras recusam.
  const code = await page.evaluate(() => LetzFB.markWorkout(2, 0).then(() => 'ok', (e) => e.code || String(e)));
  expect(code).toMatch(/permission-denied/);
});

test('foto de treino sobe comprimida', async ({ page }) => {
  const a = await makeAthlete();
  await login(page, a);
  await page.getByRole('button', { name: /Marcar como feito/ }).first().click();
  await page.getByRole('button', { name: 'Adicionar foto' }).first().click();
  await page.locator('#ph-gal').setInputFiles(await jpeg(page, 4000, 3000));
  await expect(page.getByAltText('Foto escolhida')).toBeVisible();
  await page.getByPlaceholder('Conte para a turma').fill('Treino bom');
  await page.getByRole('button', { name: 'Publicar no feed' }).click();
  await expect(page.getByAltText('Sua foto do treino')).toBeVisible();

  const obj = await waitUntil(() => storageObject(`workouts/${a.uid}/1-0.jpg`));
  expect(obj.contentType).toBe('image/jpeg');
  expect(Number(obj.size)).toBeLessThan(2 * 1024 * 1024);
  const post = (await db.doc(`posts/${a.uid}_1-0`).get()).data();
  expect(post.photoPath).toBe(`workouts/${a.uid}/1-0.jpg`);
  expect(post.comment).toBe('Treino bom');
});

test('tirar foto do treino mantém o treino marcado e os pontos', async ({ page }) => {
  const a = await makeAthlete();
  await login(page, a);
  await page.getByRole('button', { name: /Marcar como feito/ }).first().click();
  await page.getByRole('button', { name: 'Adicionar foto' }).first().click();
  await page.locator('#ph-gal').setInputFiles(await jpeg(page, 800, 600));
  await page.getByRole('button', { name: 'Publicar no feed' }).click();
  await expect(page.getByAltText('Sua foto do treino')).toBeVisible();
  await waitUntil(async () => (await db.doc('users/' + a.uid).get()).data().points === 3);

  await page.getByRole('button', { name: 'Tirar foto' }).click();
  await expect(page.getByAltText('Sua foto do treino')).toHaveCount(0);
  await expect(page.getByText('Feito', { exact: true }).first()).toBeVisible();
  const post = await waitUntil(async () => {
    const d = await db.doc(`posts/${a.uid}_1-0`).get();
    return d.exists && d.data().imgURL === '' ? d.data() : null;
  });
  expect(post.photoPath).toBe('');
  expect((await db.doc('users/' + a.uid).get()).data().points).toBe(3);
  await waitUntil(async () => (await storageObject(`workouts/${a.uid}/1-0.jpg`)) === null);
});

test('reagir e comentar aparecem para o outro aluno', async ({ page, browser }) => {
  const a = await makeAthlete();
  const b = await makeAthlete();
  await login(page, a);
  await page.getByRole('button', { name: /Marcar como feito/ }).first().click();
  await expect(page.getByText('Feito', { exact: true }).first()).toBeVisible();

  const ctx = await browser.newContext();
  const pb = await ctx.newPage();
  await login(pb, b);
  await tab(pb, 'Feed');
  const post = pb.locator('.post', { hasText: '@' + a.handle });
  await expect(post).toBeVisible();
  await post.getByRole('button', { name: /Reagir com fogo/i }).click();
  await post.getByRole('button', { name: /^Comentar/ }).click();
  await post.getByPlaceholder('Escreva um comentário').fill('Bora, parabéns!');
  await post.getByRole('button', { name: 'Enviar comentário' }).click();
  await expect(post.locator('.cm', { hasText: 'Bora, parabéns!' })).toContainText('@' + b.handle);

  // A vê o comentário e a reação (contagem pela Function).
  await tab(page, 'Feed');
  const mine = page.locator('.post', { hasText: '@' + a.handle });
  await expect(mine.locator('.cm', { hasText: 'Bora, parabéns!' })).toBeVisible();
  await expect(mine.getByRole('button', { name: /Reagir com fogo, 1/i })).toBeVisible();
  await ctx.close();
});

// ---------- medalha ----------
const CHECKOUT_URL = /^http:\/\/127\.0\.0\.1:7777\/checkoutSession\/show\/[^/]+$/;
const DAY = 864e5;
const ts = (ms) => admin.firestore.Timestamp.fromMillis(ms);

// Aluno de verdade: cadastro pela callable (perfil com endereço e CPF) e pagamento pelo webhook.
async function realStudent() {
  await clearRateLimits();
  const p = person();
  const r = await callable('signup', { ...p, acceptPolicy: true });
  expect(r.error, JSON.stringify(r.error)).toBeUndefined();
  const uid = (await auth.getUserByEmail(p.email)).uid;
  const billing = (await db.doc(`users/${uid}/private/billing`).get()).data();
  const res = await fetch(`${FAKE}/__emit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: WEBHOOK, token: webhookToken(), body: checkoutPaid(uid, billing.checkoutId) }),
  });
  expect((await res.json()).status).toBe(200);
  await waitUntil(async () => (await db.doc('users/' + uid).get()).data().access === 'active');
  const handle = uniqueHandle();
  await db.doc('handles/' + handle).set({ uid });
  await db.doc('users/' + uid).update({ profiled: true, welcomed: true, handle });
  return { ...p, uid, handle };
}

// Aluno que concluiu: treinos gravados e marcador users.concluded já escrito pelo servidor.
async function concludedStudent() {
  const a = await realStudent();
  await seedConcluded(a);
  await waitUntil(async () => (await db.doc('users/' + a.uid).get()).data().concluded === true);
  return a;
}

const fakeCheckout = async (id) => (await (await fetch(`${FAKE}/__checkouts`)).json()).find((c) => c.id === id);
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test.describe('medalha', () => {
  test('modal ao abrir: Depois fecha e o aviso continua na aba de fim', async ({ page }) => {
    const a = await concludedStudent();
    await login(page, a);
    const modal = page.getByRole('dialog', { name: /Você ganhou a medalha/ });
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('R$ 35,00');
    await modal.getByRole('button', { name: 'Depois' }).click();
    await expect(modal).toHaveCount(0);
    await page.getByRole('button', { name: /Você concluiu o Do 0 aos 5 km/ }).click();
    await expect(page).toHaveURL(/#\/app\/fim$/);
    await page.getByRole('button', { name: /Pedir minha medalha/ }).click();
    await expect(page.getByRole('dialog', { name: /Para onde enviamos/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('Continuar: endereço do cadastro numa linha, confirmar abre o checkout de R$ 35', async ({ page }) => {
    const a = await concludedStudent();
    await login(page, a);
    await page.getByRole('button', { name: 'Continuar' }).click();
    const dlg = page.getByRole('dialog', { name: /Para onde enviamos/ });
    await expect(dlg.locator('.addrline')).toContainText('Rua da Aurora, 100 · Boa Vista · Recife/PE · CEP 50050-000');
    await expect(dlg.getByLabel('CEP')).toHaveCount(0);
    await dlg.getByRole('button', { name: 'Usar o endereço do cadastro' }).click();
    await page.waitForURL(CHECKOUT_URL);
    const co = await fakeCheckout(page.url().split('/').pop());
    expect(co.items[0].value).toBe(35);
    expect(co.installment).toBeNull();
    const medal = (await db.doc(`users/${a.uid}/private/medal`).get()).data();
    expect(medal.status).toBe('pending');
    expect(medal.address.street).toBe('Rua da Aurora');
  });

  test('Informar outro: CEP com ViaCEP, número, e confirmar abre o checkout', async ({ page }) => {
    await mockViaCep(page);
    const a = await concludedStudent();
    await login(page, a);
    await page.getByRole('button', { name: 'Continuar' }).click();
    await page.getByRole('button', { name: 'Informar outro' }).click();
    await page.getByLabel('CEP').fill('50030-230');
    await expect(page.getByText('Endereço encontrado. Falta só o número.')).toBeVisible();
    await page.getByLabel('Número').fill('77');
    await page.getByLabel('Complemento').fill('Apto 2');
    await page.getByRole('button', { name: /Ir para o pagamento/ }).click();
    await page.waitForURL(CHECKOUT_URL);
    const medal = (await db.doc(`users/${a.uid}/private/medal`).get()).data();
    expect(medal.address).toMatchObject({ cep: '50030230', number: '77', complement: 'Apto 2', city: 'Recife', uf: 'PE' });
  });

  test('Informar outro sem número mostra o erro e não abre pagamento', async ({ page }) => {
    await mockViaCep(page);
    const a = await concludedStudent();
    await login(page, a);
    await page.getByRole('button', { name: 'Continuar' }).click();
    await page.getByRole('button', { name: 'Informar outro' }).click();
    await page.getByRole('button', { name: /Ir para o pagamento/ }).click();
    await expect(page.getByRole('alert')).toContainText('CEP');
    await expect(page).not.toHaveURL(CHECKOUT_URL);
  });

  test('conta sem endereço no cadastro cai direto em informar outro', async ({ page }) => {
    const a = await concludedStudent();
    await db.doc(`users/${a.uid}/private/profile`).update({ address: admin.firestore.FieldValue.delete() });
    await login(page, a);
    await page.getByRole('button', { name: 'Continuar' }).click();
    const dlg = page.getByRole('dialog', { name: /Para onde enviamos/ });
    await expect(dlg.getByLabel('CEP')).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Usar o endereço do cadastro' })).toHaveCount(0);
  });

  test('aluno que não concluiu não vê modal nem a aba de fim', async ({ page }) => {
    const a = await makeAthlete();
    await login(page, a);
    await expect(page).toHaveURL(/#\/app\/treinos$/);
    await expect(page.getByRole('heading', { name: /Semana/ }).first()).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Você concluiu/ })).toHaveCount(0);
    await page.goto('/#/app/fim');
    await expect(page).toHaveURL(/#\/app\/treinos$/);
  });

  test('#/medalha: confirmando, vira status ao webhook e mostra rastreio e datas', async ({ page }) => {
    const a = await concludedStudent();
    await login(page, a);
    await page.getByRole('button', { name: 'Continuar' }).click();
    await page.getByRole('button', { name: 'Usar o endereço do cadastro' }).click();
    await page.waitForURL(CHECKOUT_URL);
    const checkoutId = page.url().split('/').pop();

    await page.goto('/#/medalha');
    await expect(page.getByText('Confirmando seu pagamento…')).toBeVisible();
    expect(await emitMedalPaid(checkoutId)).toBe(200);
    await expect(page.getByText('Pago, aguardando envio')).toBeVisible();
    await expect(page.getByText('Rua da Aurora, 100')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Solicitar reembolso' })).toBeVisible();
    // pago: o modal não volta
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await db.doc(`users/${a.uid}/private/medal`).update({ status: 'shipped', trackingCode: 'BR123456789BR', shippedAt: '2026-11-03' });
    await expect(page.getByText('Enviada', { exact: true })).toBeVisible();
    await expect(page.getByText('03/11/2026')).toBeVisible();
    await expect(page.locator('#trk-code')).toHaveText('BR123456789BR');
    await expect(page.getByRole('button', { name: 'Solicitar reembolso' })).toHaveCount(0);
    await expect(page.getByText(/para qualquer reembolso fale com os instrutores/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Falar com a assessoria' })).toHaveAttribute('href', /^https:\/\/wa\.me\/\d+\?text=/);

    await db.doc(`users/${a.uid}/private/medal`).update({ status: 'delivered', deliveredAt: '2026-11-09' });
    await expect(page.getByText('Entregue', { exact: true })).toBeVisible();
    await expect(page.getByText('09/11/2026')).toBeVisible();
    expect(await noHScroll(page)).toBe(true);
  });

  test('#/medalha sem pedido pago não finge pagamento', async ({ page }) => {
    const a = await concludedStudent();
    await login(page, a);
    await expect(page).toHaveURL(/#\/app\/treinos$/);
    await page.goto('/#/medalha');
    await expect(page.getByText('Você ainda não tem uma medalha paga.')).toBeVisible();
    await page.getByRole('button', { name: 'Voltar ao app' }).click();
    await expect(page).toHaveURL(/#\/app\/fim$/);
  });

  test('reembolso do medalha pago: botão registra o pedido e abre o WhatsApp', async ({ page }) => {
    await page.addInitScript(() => { window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; }; });
    const a = await concludedStudent();
    await db.doc(`users/${a.uid}/private/medal`).set({
      status: 'paid', paidAt: ts(Date.now()), refundCount: 0,
      address: { cep: '50050000', street: 'Rua da Aurora', number: '100', complement: '', district: 'Boa Vista', city: 'Recife', uf: 'PE' },
    });
    await login(page, a);
    await page.getByRole('button', { name: /Você concluiu o Do 0 aos 5 km/ }).click();
    await page.getByRole('button', { name: 'Solicitar reembolso' }).click();
    await expect(page.getByText('Pedido de reembolso registrado.')).toBeVisible();
    const opened = await page.evaluate(() => window.__opened);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^https:\/\/wa\.me\/\d+\?text=/);
    expect(decodeURIComponent(opened[0])).toContain('reembolso da medalha');
    expect(decodeURIComponent(opened[0])).toContain(a.email);
    await waitUntil(async () => (await db.doc(`users/${a.uid}/private/medal`).get()).data().refundRequestedAt);
  });

  test('reembolso do programa só no perfil: Treinos não tem o botão; perfil tem seção com contador, direto e ao recarregar, sem rolagem lateral', async ({ page }) => {
    const a = await realStudent();
    await db.doc(`users/${a.uid}/private/billing`).update({ paidAt: ts(Date.now() - 2 * DAY) });
    await login(page, a);
    await expect(page.getByRole('navigation', { name: 'Principal' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Solicitar reembolso' })).toHaveCount(0);
    await expect(page.locator('#refund-program')).toHaveCount(0);
    await page.goto('/#/perfil');
    await expect(page.getByText('Pagamento e reembolso')).toBeVisible();
    await expect(page.locator('#refund-program')).toContainText('Faltam 5 dias do prazo de reembolso');
    await expect(page.locator('#refund-program').getByRole('button', { name: 'Solicitar reembolso' })).toBeVisible();
    await page.reload();
    await expect(page.locator('#refund-program')).toContainText('Faltam 5 dias');
    await page.setViewportSize({ width: 390, height: 800 });
    expect(await noHScroll(page)).toBe(true);
  });

  test('reembolso do programa: contador de dias, WhatsApp e, depois do prazo, só o contato', async ({ page }) => {
    await page.addInitScript(() => { window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; }; });
    const a = await realStudent();
    await db.doc(`users/${a.uid}/private/billing`).update({ paidAt: ts(Date.now() - 2 * DAY) });
    await login(page, a);
    await expect(page.getByRole('navigation', { name: 'Principal' })).toBeVisible();
    await page.goto('/#/perfil');
    const card = page.locator('#refund-program');
    await expect(card).toContainText('Faltam 5 dias do prazo de reembolso');
    await card.getByRole('button', { name: 'Solicitar reembolso' }).click();
    await expect(card.getByText('Pedido de reembolso registrado.')).toBeVisible();
    const opened = await page.evaluate(() => window.__opened);
    expect(opened).toHaveLength(1);
    expect(decodeURIComponent(opened[0])).toContain('reembolso do programa');
    await waitUntil(async () => (await db.doc(`users/${a.uid}/private/billing`).get()).data().refundRequestedAt);

    await db.doc(`users/${a.uid}/private/billing`).update({ paidAt: ts(Date.now() - 8 * DAY) });
    await expect(card.getByRole('button', { name: 'Solicitar reembolso' })).toHaveCount(0);
    await expect(card.getByRole('link', { name: 'Falar com a assessoria' })).toHaveAttribute('href', /^https:\/\/wa\.me\//);
  });

  test('conta reembolsada vê Comprar de novo e vai ao checkout do programa; com refundCount 2 só o contato', async ({ page }) => {
    const a = await realStudent();
    await db.doc(`users/${a.uid}/private/billing`).update({ status: 'refunded', refundCount: 1 });
    await db.doc('users/' + a.uid).update({ access: 'blocked' });
    await login(page, a);
    await expect(page).toHaveURL(/#\/bloqueado$/);
    await page.getByRole('button', { name: /Comprar de novo/ }).click();
    await page.waitForURL(CHECKOUT_URL);
    const co = await fakeCheckout(page.url().split('/').pop());
    expect(co.items[0].value).toBe(159);

    const b = await realStudent();
    await db.doc(`users/${b.uid}/private/billing`).update({ status: 'refunded', refundCount: 2 });
    await db.doc('users/' + b.uid).update({ access: 'blocked' });
    const ctx = await page.context().browser().newContext();
    const pb = await ctx.newPage();
    await login(pb, b);
    await expect(pb).toHaveURL(/#\/bloqueado$/);
    await expect(pb.getByText(/Você já usou a compra de novo/)).toBeVisible();
    await expect(pb.getByRole('button', { name: /Comprar de novo/ })).toHaveCount(0);
    await expect(pb.getByRole('link', { name: 'Chamar no WhatsApp' })).toBeVisible();
    await ctx.close();
  });

  test('390 px: modal, conclusão e medalha sem rolagem horizontal', async ({ page }) => {
    await mockViaCep(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const a = await concludedStudent();
    await login(page, a);
    await expect(page.getByRole('dialog', { name: /Você ganhou a medalha/ })).toBeVisible();
    expect(await noHScroll(page)).toBe(true);
    await page.getByRole('button', { name: 'Continuar' }).click();
    await page.getByRole('button', { name: 'Informar outro' }).click();
    await page.getByLabel('CEP').fill('50030-230');
    await expect(page.getByLabel('Número')).toBeVisible();
    expect(await noHScroll(page)).toBe(true);
    await page.keyboard.press('Escape');
    await page.goto('/#/app/fim');
    expect(await noHScroll(page)).toBe(true);
  });
});

test.describe('post da medalha no feed', () => {
  const order = (uid, status) => db.doc(`users/${uid}/private/medal`).set({
    status, address: { cep: '50050000', street: 'Rua da Aurora', number: '100', complement: '', district: 'Boa Vista', city: 'Recife', uf: 'PE' },
    paidAt: admin.firestore.Timestamp.now(), refundCount: 0,
  });

  test('pago ou reembolsado: sem botão; enviado: posta uma vez, aparece com selo, sem pontos; treinador esconde', async ({ page, browser }) => {
    const a = await makeAthlete();
    // Um treino real (a função recalcula pontos a partir dos posts): 3 pontos, 1 feito.
    await db.doc(`posts/${a.uid}_1-0`).set({
      uid: a.uid, handle: a.handle, name: a.name, photoURL: '', w: 1, d: 0, at: admin.firestore.Timestamp.now(),
      comment: '', photoPath: '', imgURL: '', hidden: false, authorActive: true,
    });
    await waitUntil(async () => (await db.doc('users/' + a.uid).get()).data().points === 3);
    await order(a.uid, 'paid');
    await login(page, a);
    await expect(page).toHaveURL(/#\/app\//);
    await page.goto('/#/medalha');
    await expect(page.getByText('Pago, aguardando envio')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Postar no feed' })).toHaveCount(0);

    await order(a.uid, 'refunded');
    await expect(page.getByRole('button', { name: 'Postar no feed' })).toHaveCount(0);

    await order(a.uid, 'shipped');
    await expect(page.getByRole('button', { name: 'Postar no feed' })).toBeVisible();
    await page.getByRole('button', { name: 'Postar no feed' }).click();
    await expect(page.getByText('Escreva como foi ou adicione uma foto.')).toBeVisible();
    await page.getByRole('button', { name: 'Adicionar foto' }).click();
    await page.locator('#ph-gal').setInputFiles(await jpeg(page, 1600, 1200));
    await page.getByLabel('Como foi? (opcional)').fill('Chegou! Que orgulho');
    await page.getByRole('button', { name: 'Postar no feed' }).click();
    await expect(page.getByText('Sua medalha já está no feed.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Postar no feed' })).toHaveCount(0);

    const post = (await waitUntil(async () => { const d = await db.doc(`posts/${a.uid}_medal`).get(); return d.exists ? d : null; })).data();
    expect(post.medal).toBe(true);
    expect(post.w).toBeUndefined();
    expect(post.d).toBeUndefined();
    expect(post.comment).toBe('Chegou! Que orgulho');
    expect(post.photoPath).toBe(`workouts/${a.uid}/medal.jpg`);
    expect((await storageObject(`workouts/${a.uid}/medal.jpg`)).contentType).toBe('image/jpeg');

    // Outro aluno vê o selo, reage e comenta; nada de "treino" nem "undefined".
    const b = await makeAthlete();
    const ctx = await browser.newContext();
    const pb = await ctx.newPage();
    await login(pb, b);
    await tab(pb, 'Feed');
    const card = pb.locator('.post', { hasText: '@' + a.handle }).filter({ has: pb.locator('.tag', { hasText: 'Medalha' }) });
    await expect(card).toBeVisible();
    await expect(card.locator('.tag')).toHaveText('Medalha');
    await expect(card).toContainText('Chegou! Que orgulho');
    await expect(card.locator('.pimg')).toBeVisible();
    await expect(card).not.toContainText(/undefined|treino de/);
    await card.getByRole('button', { name: /Reagir com/ }).first().click();
    await waitUntil(async () => Object.keys((await db.doc(`posts/${a.uid}_medal`).get()).data().rc || {}).length > 0);
    await card.getByRole('button', { name: /Comentar/ }).click();
    await card.getByLabel('Escreva um comentário').fill('Parabéns!');
    await card.getByRole('button', { name: 'Enviar comentário' }).click();
    await expect(card).toContainText('Parabéns!');

    // Sem pontos: nem o aluno nem o ranking mudam.
    await new Promise((r) => setTimeout(r, 1500));
    const u = (await db.doc('users/' + a.uid).get()).data();
    expect(u.points).toBe(3);
    expect(u.done).toBe(1);

    // Treinador vê o post sem "undefined" e esconde.
    const cp = await (await browser.newContext()).newPage();
    const c = await makeCoach();
    await login(cp, c);
    await cp.getByRole('group', { name: 'Seções' }).getByRole('button', { name: 'Feed' }).click();
    const adm = cp.locator('.post', { hasText: '@' + a.handle }).filter({ has: cp.locator('.tag', { hasText: 'Medalha' }) });
    await expect(adm.locator('.tag')).toHaveText('Medalha');
    await expect(adm).not.toContainText(/undefined|treino de/);
    await adm.getByRole('button', { name: 'Esconder post' }).click();
    await waitUntil(async () => (await db.doc(`posts/${a.uid}_medal`).get()).data().hidden === true);
    await expect(card).toHaveCount(0);
    await ctx.close();
  });
});
