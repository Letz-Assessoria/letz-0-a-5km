import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const core = createRequire(import.meta.url)('../../public/lib/core.js');
const { WEEK_MS, weekOpen, weekIndex, pointedKeys, pointsFor, isConcluded, isValidCpf, normalizeCpf, normalizePhone, normalizeCep, cleanAddress, cleanHandle } = core;
const start = Date.parse('2026-11-08T18:00:00-03:00');

test('pointsFor: 4 marcações na semana 1 dão 9 pontos e 4 feitos', () => {
  const m = { '1-0': start + 1000, '1-1': start + 2000, '1-2': start + 3000, '1-3': start + 4000 };
  assert.deepEqual(pointsFor(m, start), { points: 9, done: 4 });
});
test('pointsFor: 3 na semana 1 e 3 na semana 2 dão 18 pontos e 6 feitos', () => {
  const m = {};
  for (let i = 0; i < 3; i++) { m['1-' + i] = start + i * 1000; m['2-' + i] = start + WEEK_MS + i * 1000; }
  assert.deepEqual(pointsFor(m, start), { points: 18, done: 6 });
});
test('pointedKeys: entram os 3 primeiros por horário', () => {
  const m = { a: start + 4000, b: start + 1000, c: start + 2000, d: start + 3000 };
  assert.deepEqual([...pointedKeys(m, start)].sort(), ['b', 'c', 'd']);
});
test('weekOpen: abre exatamente no início da semana', () => {
  assert.equal(weekOpen(start, 2, start + WEEK_MS - 1), false);
  assert.equal(weekOpen(start, 2, start + WEEK_MS), true);
});
test('weekIndex nunca é negativo', () => {
  assert.equal(weekIndex(start, start - 5), 0);
  assert.equal(weekIndex(start, start + WEEK_MS), 1);
});
test('isConcluded exige 24 marcações e a "10-2"', () => {
  const m = {};
  for (let i = 0; i < 24; i++) m['k' + i] = 1;
  assert.equal(isConcluded(m), false);
  delete m.k0; m['10-2'] = 1;
  assert.equal(isConcluded(m), true);
});
test('CPF', () => {
  assert.equal(isValidCpf('529.982.247-25'), true);
  assert.equal(isValidCpf('111.111.111-11'), false);
  assert.equal(isValidCpf('123'), false);
  assert.equal(normalizeCpf('529.982.247-25'), '52998224725');
});
test('normalizePhone', () => {
  assert.equal(normalizePhone('(87) 98190-8719'), '87981908719');
  assert.equal(normalizePhone('1234'), null);
});
test('cleanHandle', () => {
  assert.equal(cleanHandle('@@Fe.Lipe!x'), 'fe.lipex');
});

test('projectForHost: dev, preview de dev, prod, preview de prod, domínio próprio e local', () => {
  assert.equal(core.projectForHost('letz-0-aos-5km-dev.web.app'), 'dev');
  assert.equal(core.projectForHost('letz-0-aos-5km-dev--pr1-abc.web.app'), 'dev');
  assert.equal(core.projectForHost('letz-0-aos-5km.web.app'), 'prod');
  assert.equal(core.projectForHost('letz-0-aos-5km--pr1-abc.web.app'), 'prod');
  assert.equal(core.projectForHost('www.exemplo.com.br'), 'prod');
  assert.equal(core.projectForHost('localhost'), 'local');
  assert.equal(core.projectForHost('127.0.0.1'), 'local');
});

test('normalizeCep e cleanAddress', () => {
  assert.equal(normalizeCep('50050-000'), '50050000');
  assert.equal(normalizeCep('5005'), null);
  const ok = { cep: '50050-000', street: ' Rua  da Aurora ', number: '100', complement: '', district: 'Boa Vista', city: 'Recife', uf: 'pe' };
  assert.deepEqual(cleanAddress(ok), { cep: '50050000', street: 'Rua da Aurora', number: '100', complement: '', district: 'Boa Vista', city: 'Recife', uf: 'PE' });
  assert.equal(cleanAddress({ ...ok, number: '' }), null);
  assert.equal(cleanAddress({ ...ok, uf: 'PER' }), null);
  assert.equal(cleanAddress({ ...ok, cep: '123' }), null);
  assert.equal(cleanAddress({ ...ok, street: 'x'.repeat(101) }), null);
  assert.equal(cleanAddress(null), null);
});
