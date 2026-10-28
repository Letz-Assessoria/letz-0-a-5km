// Gera .test-rules/ (git-ignorado) com uma cópia das regras que aceita também o host do
// emulador do Storage em imgUrlOk, e firebase.test.json apontando para ela.
// As regras de produção (firestore.rules) NÃO aceitam o emulador.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const prod = "v.matches('^https://firebasestorage[.]googleapis[.]com/v0/b/.*')";
const src = readFileSync(new URL('firestore.rules', root), 'utf8');
if (!src.includes(prod)) throw new Error('imgUrlOk mudou; ajuste scripts/make-test-rules.mjs');
const test = src.replace(prod, prod + "\n        || v.matches('^http://(127[.]0[.]0[.]1|localhost):9199/v0/b/.*')");
mkdirSync(new URL('.test-rules/', root), { recursive: true });
writeFileSync(new URL('.test-rules/firestore.rules', root), test);
const cfg = JSON.parse(readFileSync(new URL('firebase.json', root), 'utf8'));
cfg.firestore.rules = '.test-rules/firestore.rules';
writeFileSync(new URL('firebase.test.json', root), JSON.stringify(cfg, null, 2));
