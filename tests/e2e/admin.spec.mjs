// e2e do painel do treinador: acesso, bloqueio, moderação, frete, data da turma e vendas.
import { test, expect } from '@playwright/test';
import {
  admin, auth, clearRateLimits, db, makeAthlete, makeCoach, makeUser, person, resetStart, seedConcluded, setStart,
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

test('marcar frete pago e rastreio aparecem para o aluno', async ({ page, browser }) => {
  const a = await makeAthlete();
  await seedConcluded(a);
  await db.doc(`users/${a.uid}/private/ship`).set({
    nome: a.name, cep: '50000000', rua: 'Rua ' + a.handle, num: '10', comp: '', bairro: 'Centro', cidade: 'Recife', uf: 'PE',
    tel: '81999990000', at: admin.firestore.Timestamp.now(),
  });
  await coachPanel(page, 'Medalhas');
  const card = page.locator('section', { hasText: 'Rua ' + a.handle });
  await expect(card).toContainText(a.name);
  await card.getByRole('button', { name: 'Marcar frete pago' }).click();
  await waitUntil(async () => (await db.doc(`users/${a.uid}/private/ship`).get()).data().paidAt);
  await card.getByLabel(/Código de rastreio/).fill('aa123456789br');
  await card.getByLabel(/Código de rastreio/).blur();
  await waitUntil(async () => (await db.doc(`users/${a.uid}/private/ship`).get()).data().track === 'AA123456789BR');

  const ctx = await browser.newContext();
  const pa = await ctx.newPage();
  await login(pa, a);
  await expect(pa).toHaveURL(/#\/app\/treinos$/);
  await pa.getByRole('button', { name: /Você concluiu o Do 0 aos 5 km/ }).click();
  await expect(pa.getByText('AA123456789BR')).toBeVisible();
  await ctx.close();
});

test('mudar data da turma tranca semanas para o aluno', async ({ page, browser }) => {
  const a = await makeAthlete();
  const ctx = await browser.newContext();
  const pa = await ctx.newPage();
  await login(pa, a);
  await expect(pa.getByText('Ainda trancada')).toHaveCount(0);

  await coachPanel(page);
  const d = new Date(Date.now() + 10 * 864e5);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  await page.getByLabel(/Abertura da semana 1/).fill(local);
  await page.getByRole('button', { name: 'Salvar data' }).click();
  const start = await waitUntil(async () => {
    const x = (await db.doc('config/app').get()).data().start.toMillis();
    return x > Date.now() ? x : 0;
  });
  expect(Math.abs(start - new Date(local).getTime())).toBeLessThan(61000);
  await expect(pa.getByText('Ainda trancada')).toBeVisible();
  await ctx.close();
});

test('fechar vendas faz o cadastro mostrar vendas encerradas', async ({ page, browser }) => {
  await coachPanel(page);
  await page.getByLabel('Vendas abertas').uncheck();
  await waitUntil(async () => (await db.doc('config/app').get()).data().salesOpen === false);

  await clearRateLimits();
  const p = person();
  const ctx = await browser.newContext();
  const pc = await ctx.newPage();
  await pc.goto('/#/cadastro');
  await pc.getByLabel('Nome completo').fill(p.name);
  await pc.getByLabel('E-mail').fill(p.email);
  await pc.getByLabel('CPF').fill(p.cpf);
  await pc.getByLabel('Celular com DDD').fill(p.phone);
  await pc.getByLabel('Senha', { exact: true }).fill(p.password);
  await pc.getByLabel('Confirme a senha').fill(p.password);
  await pc.getByLabel(/Li e aceito a política de privacidade/).check();
  await pc.getByRole('button', { name: /Criar conta e ir para o pagamento/ }).click();
  await expect(pc.getByRole('alert')).toContainText('As vendas estão encerradas.');
  await ctx.close();
  await expect(auth.getUserByEmail(p.email)).rejects.toBeTruthy();
});

test('painel não mostra botões de simulação', async ({ page }) => {
  await coachPanel(page);
  for (const s of ['Turma', 'Treinos', 'Conteúdo', 'Medalhas', 'Atletas', 'Feed']) {
    await page.getByRole('group', { name: 'Seções' }).getByRole('button', { name: s }).click();
    await expect(page.locator('body')).not.toContainText(/teste|Simular|Kiwify|Liberar as 10 semanas/i);
  }
});

test('ver como atleta não cria perfil nem entra no ranking', async ({ page }) => {
  const c = await coachPanel(page);
  await page.getByRole('button', { name: 'Ver como atleta' }).click();
  await expect(page.getByRole('navigation', { name: 'Principal' })).toBeVisible();
  await tab(page, 'Ranking');
  expect((await db.doc('users/' + c.uid).get()).exists).toBe(false);
});

test('treinador recarregando #/app/treinos não vai para o perfil', async ({ page }) => {
  await coachPanel(page);
  await page.getByRole('button', { name: 'Ver como atleta' }).click();
  await expect(page).toHaveURL(/#\/app\/treinos$/);
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Principal' })).toBeVisible();
  await expect(page).toHaveURL(/#\/app\/treinos$/);
  await page.goto('/#/perfil');
  await page.reload();
  await expect(page).toHaveURL(/#\/admin\//);
});

test('treinador abre #/admin/atletas direto', async ({ page }) => {
  const c = await makeCoach();
  await page.goto('/#/admin/atletas');
  await page.getByLabel('E-mail').fill(c.email);
  await page.getByLabel('Senha', { exact: true }).fill(c.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/#\/admin\/atletas$/);
  await page.reload();
  await expect(page).toHaveURL(/#\/admin\/atletas$/);
  await expect(page.getByRole('heading', { name: 'Painel' })).toBeVisible();
});

test('alertas de pagamento aparecem no topo da aba Atletas e podem ser resolvidos', async ({ page }) => {
  const s = await makeUser('pending', { profiled: true, welcomed: true, handle: uniqueHandle() });
  await withProfile(s);
  const ref = await db.collection('alerts').add({
    type: 'duplicate-payment', uid: s.uid, checkoutId: 'ck-e2e', eventId: 'evt-e2e', at: new Date(), resolved: false,
  });
  await coachPanel(page, 'Atletas');
  const box = page.locator('[data-alerts]');
  await expect(box).toContainText('Atenção: 1 alerta de pagamento');
  await expect(box).toContainText('Segundo pagamento de conta já paga');
  await box.getByRole('button', { name: 'Marcar resolvido' }).click();
  await expect(box).toHaveCount(0);
  await waitUntil(async () => (await ref.get()).data().resolved === true);
});
