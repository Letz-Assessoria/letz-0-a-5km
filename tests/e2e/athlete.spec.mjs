// e2e do aluno: perfil, treinos, feed, ranking, fotos, reações, comentários e endereço da medalha.
import { test, expect } from '@playwright/test';
import {
  db, makeAthlete, makeUser, resetStart, seedConcluded, setStart, storageObject, uniqueHandle, waitUntil,
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

test('endereço da medalha persiste após recarregar', async ({ page }) => {
  const a = await makeAthlete();
  await seedConcluded(a);
  await login(page, a);
  await expect(page).toHaveURL(/#\/app\/treinos$/);
  await page.getByRole('button', { name: /Você concluiu o Do 0 aos 5 km/ }).click();
  await page.getByRole('button', { name: /Informar endereço de entrega/ }).click();
  await page.getByLabel('Nome de quem vai receber').fill('Fulana de Tal');
  await page.getByLabel('Rua ou avenida').fill('Rua das Flores');
  await page.getByLabel('Número').fill('10');
  await page.getByLabel('Bairro').fill('Centro');
  await page.getByLabel('Cidade').fill('Recife');
  await page.getByLabel('Estado').selectOption('PE');
  await page.getByLabel('CEP').fill('50000000');
  await page.getByRole('button', { name: /Confirmar endereço/ }).click();
  await expect(page.getByText('Pague com Pix')).toBeVisible();
  await expect(page.getByText(/Simular|Versão de teste/)).toHaveCount(0);
  await page.locator('.linkbtn', { hasText: 'Pagar depois' }).click();

  const saved = await waitUntil(async () => (await db.doc(`users/${a.uid}/private/ship`).get()).data());
  expect(saved.rua).toBe('Rua das Flores');
  await page.reload();
  await page.getByRole('button', { name: /Você concluiu o Do 0 aos 5 km/ }).click();
  await expect(page.getByText('Rua das Flores, 10')).toBeVisible();
});
