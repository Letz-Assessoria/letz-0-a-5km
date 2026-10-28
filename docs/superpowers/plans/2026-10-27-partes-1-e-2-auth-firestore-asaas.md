# Partes 1 e 2: contas, Firestore/Storage e venda pelo Asaas — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Objetivo:** transformar o protótipo de um aparelho só em um app de produção, com contas reais (Firebase Auth), dados no Firestore e no Storage, e venda automática pelo Asaas (cadastro → pagamento → acesso liberado).

**Arquitetura:** o app continua em um único `public/index.html` (JS puro, IIFE clássica). Ele ganha dois scripts servidos ao lado:
- `public/lib/core.js`: lógica pura, compartilhada com as Functions e testada em Node.
- `public/js/fb.js`: módulo ES que carrega o SDK Web do Firebase e expõe uma API de dados em `window.LetzFB`.

O servidor são Cloud Functions v2 em `functions/` (Node 22, JS), responsáveis por:
- cadastro e cobrança no Asaas;
- webhook do Asaas;
- pontos e ranking;
- cópia do status do autor para os posts;
- contagem de reações.

As regras do Firestore e do Storage garantem os antiobjetivos e são testadas no emulador.

**Tecnologias:** Firebase Auth (e-mail/senha), Firestore, Cloud Storage, Cloud Functions v2 (`firebase-functions`, `firebase-admin`), Firebase Emulator Suite, `@firebase/rules-unit-testing`, `node:test`, `@playwright/test`, API v3 do Asaas.

**Specs:**
- `docs/superpowers/specs/2026-10-27-parte1-auth-firestore-design.md`
- `docs/superpowers/specs/2026-10-27-parte2-venda-asaas-design.md`

Leia os dois antes de começar. O plano argumenta a partir deles.

## Restrições globais

- Projetos Firebase: `letz-0-aos-5km` (alias `prod`) e `letz-0-aos-5km-dev` (alias `dev`). O `prod` só fala com o Asaas de produção e o `dev` só com o sandbox.
- Região do Firestore, do Storage e das Functions: `southamerica-east1`. Runtime das Functions: Node 22.
- **Repositório público.** Nada de chave do Asaas, token, e-mail de treinador ou chave privada em arquivo versionado. A config Web do Firebase pode ficar no código.
- Secrets (Secret Manager, por projeto): `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`.
- Parâmetros não secretos, em `functions/.env.letz-0-aos-5km` e `functions/.env.letz-0-aos-5km-dev`, versionados:
  - `ASAAS_BASE_URL`: `https://api.asaas.com/v3` em prod, `https://api-sandbox.asaas.com/v3` em dev;
  - `APP_URL`: `https://letz-0-aos-5km.web.app` em prod e a URL do Hosting do dev;
  - `PROGRAM_PRICE=159.00`;
  - `MAX_INSTALLMENTS=12`.
- SDK Web do Firebase: **uma versão exata**. Use a última estável publicada em `https://www.gstatic.com/firebasejs/<versão>/` no momento da Task 1, igual em todos os imports. Nada de framework e nada de build no front.
- Data padrão da turma: `2026-11-08T18:00:00-03:00`. Semana = 7 dias. Treinos `w` de 1 a 10 e `d` de 0 a 2 (terça, quinta, sábado).
- Pontos: 3 por treino, no máximo 3 treinos pontuando por semana da turma, contados por ordem de horário de marcação. É a regra atual de `pointedSet`.
- Medalha liberada: marcou o treino `10-2` e tem pelo menos 24 treinos. É a regra atual de `concluded`.
- Preço: R$ 159,00 à vista (Pix ou cartão), ou até 12x **sem juros** no cartão (12x de R$ 13,25) via Asaas Checkout (`POST /checkouts`), 100% por API. Ver `docs/asaas-notas.md`.
- Textos em português do Brasil, com acentos. Nenhum "Kiwify", "versão de teste" ou "simular" visível no app ao fim do plano.
- O estilo do código segue o `index.html`: strings de template, `render()`, `data-act`, `V` para estado de tela.

## Modelo de dados (fixo para todas as tasks)

| Caminho | Campos | Quem escreve |
|---|---|---|
| `users/{uid}` | `name`, `handle`, `photoURL`, `profiled`, `welcomed`, `access` (`pending`/`active`/`blocked`), `points`, `done`, `createdAt` | aluno: só `name`, `handle`, `photoURL`, `profiled`, `welcomed`; o resto só Functions/treinador |
| `users/{uid}/private/profile` | `email`, `cpf`, `phone`, `policyAcceptedAt` | só Functions |
| `users/{uid}/private/billing` | `asaasCustomerId`, `checkoutId`, `paymentId`, `url`, `status` (`pending`/`paid`/`refunded`/`chargeback`), `method`, `installments`, `paidAt`, `updatedAt` | só Functions |
| `users/{uid}/private/ship` | `nome`, `cep`, `rua`, `num`, `comp`, `bairro`, `cidade`, `uf`, `tel`, `at`, `paidAt`, `track` | aluno: só os campos de endereço; `paidAt`/`track` só o treinador |
| `handles/{handle}` | `uid` | aluno, na mesma transação do perfil |
| `cpfs/{cpf}` | `uid` | só Functions; ninguém lê pelo cliente |
| `posts/{uid}_{w}-{d}` | `uid`, `handle`, `name`, `photoURL`, `w`, `d`, `at`, `comment`, `photoPath`, `imgURL`, `hidden`, `authorActive`, `rc` (mapa reação→contagem) | aluno cria, edita `comment`/`photoPath`/`imgURL` e apaga o próprio post; treinador muda `hidden`; Functions mudam `authorActive`, `rc` e as cópias de autor |
| `posts/{id}/comments/{cid}` | `uid`, `handle`, `text`, `at`, `hidden` | autor cria e apaga; treinador muda `hidden` |
| `posts/{id}/reactions/{uid}` | `oi`, `clap`, `fire`, `power`, `love` (booleanos) | só o dono do `{uid}` |
| `config/app` | `start` (Timestamp), `texts` (mapa `"w-d"`→texto), `videos` (`[{t,u}]`), `av`, `wa`, `grupo`, `frete`, `pix` (`{chave,pnome,pcidade}`), `salesOpen` | só treinador |
| `asaasEvents/{eventId}` | `type`, `paymentId`, `uid`, `at` | só Functions (idempotência) |

O treinador é identificado pela custom claim `admin: true`. O treinador não tem `users/{uid}`.

## Foco de revisão

1. **Pix pago com a aba fechada e webhook repetido:** o aviso chega antes de o aluno voltar, ou chega duas vezes. Esperado: uma única ativação, e o aluno entra direto quando abrir o app. Teste na Task 6: `webhook: evento repetido ativa uma vez só`.
2. **Cadastro que falha no meio** (Asaas fora do ar depois de criar a conta). Esperado: ao tentar de novo com o mesmo e-mail e CPF, a pessoa entra, vê "Concluir pagamento" e a cobrança é criada. Não sobra conta órfã nem CPF preso. Teste na Task 6: `signup: falha no Asaas permite retomar`.
3. **Relógio do celular errado ou fuso diferente** ao marcar treino. Esperado: o horário vem do servidor e a semana trancada é recusada pelo servidor. Teste na Task 2: `posts: rejeita at diferente de request.time` e `posts: rejeita semana trancada`.
4. **Foto grande ou HEIC do iPhone.** Esperado: é comprimida para JPEG no aparelho antes de subir, e o Storage recusa acima de 2 MB ou fora de `image/*`. Teste na Task 2: `storage: rejeita 3 MB` e, na Task 8, o e2e `foto de treino sobe comprimida`.
5. **Treinador bloqueia e depois reativa um aluno.** Esperado: o aluno some do feed e do ranking e volta inteiro ao ser reativado. Teste na Task 3: `access: bloquear e reativar propaga authorActive`.

---

### Task 1: Infraestrutura e lógica compartilhada

**Arquivos:**
- Criar:
  - `package.json` (raiz): `type: module`; scripts `test:unit`, `test:rules`, `test:functions`, `test:e2e`, `emulators`;
  - `public/lib/core.js`;
  - `tests/unit/core.test.js`.
- Modificar:
  - `firebase.json`: acrescentar `firestore`, `storage`, `functions` (`source: functions`, `predeploy` copia `public/lib/core.js` para `functions/shared/core.js`), `emulators` (auth 9099, firestore 8080, storage 9199, functions 5001, hosting 5050, ui ligado);
  - `.firebaserc`: aliases `prod` e `dev`;
  - `.gitignore`: acrescentar `node_modules/`, `functions/shared/`, `*.log`, `test-results/`;
  - `public/index.html`: carregar `/lib/core.js` antes do script principal e trocar as funções duplicadas pelas de `core.js`.

**Interfaces — Produz** (`core.js` em UMD: `module.exports` no Node e `window.LetzCore` no navegador):
- `WEEK_MS: number` (604800000) e `DEFAULT_START_ISO: '2026-11-08T18:00:00-03:00'`;
- `weekOpen(startMs: number, w: number, nowMs: number): boolean`;
- `weekIndex(startMs: number, tMs: number): number`, igual ao `weekIdx` atual;
- `pointedKeys(marks: {[key: string]: number}, startMs: number): Set<string>`. As chaves são `"w-d"`, os valores são epoch ms, e entram os 3 primeiros por semana em ordem de horário;
- `pointsFor(marks, startMs): {points: number, done: number}`;
- `isConcluded(marks): boolean`;
- `isValidCpf(s: string): boolean` e `normalizeCpf(s): string` (só os 11 dígitos);
- `normalizePhone(s): string | null`, que devolve só os dígitos com DDD (10 ou 11) ou `null`;
- `cleanHandle(s): string`, igual ao atual.

- [ ] **Passo 1: Escrever os testes que falham** em `tests/unit/core.test.js`:
  - `pointsFor` com 4 marcações na semana 1 dá `{points: 9, done: 4}`;
  - 3 marcações na semana 1 e 3 na semana 2 dão `{points: 18, done: 6}`;
  - `weekOpen(start, 2, start + WEEK_MS - 1) === false` e `weekOpen(start, 2, start + WEEK_MS) === true`;
  - `isConcluded`: 24 marcações sem `"10-2"` é `false`; 24 com `"10-2"` é `true`;
  - `isValidCpf('529.982.247-25') === true`, `isValidCpf('111.111.111-11') === false` e `isValidCpf('123') === false`;
  - `normalizePhone('(87) 98190-8719') === '87981908719'` e `normalizePhone('1234') === null`.
- [ ] **Passo 2:** `npm run test:unit` → FAIL, porque o módulo ainda não existe.
- [ ] **Passo 3:** implementar `public/lib/core.js`. Mover a lógica de `pointedSet`, `weekIdx`, `concluded` e `cleanHandle` do `index.html` para lá. O `index.html` passa a chamar `LetzCore.*`.
- [ ] **Passo 4:** `npm run test:unit` → PASS. Abrir `public/index.html` com `npx firebase emulators:start --only hosting` e conferir que a landing renderiza sem erro no console.
- [ ] **Passo 5:** no projeto **dev**, criar o Firestore e o Storage em `southamerica-east1` pelo console ou pelo `firebase init` (o dono precisa ter habilitado o Blaze). Ativar o provedor E-mail/Senha no Auth. Registrar o app Web e guardar a config para a Task 7.
- [ ] **Passo 6: Commit** — `git commit -m "infra: emuladores, aliases dev/prod e lógica compartilhada em core.js"`

### Task 2: Regras do Firestore e do Storage

**Arquivos:**
- Criar:
  - `firestore.rules`;
  - `firestore.indexes.json`;
  - `storage.rules`;
  - `tests/rules/firestore.test.js`;
  - `tests/rules/storage.test.js`.

**Interfaces — Consome:** o modelo de dados acima, mais `WEEK_MS` e a data padrão (Task 1).
**Interfaces — Produz:**
- Índices compostos:
  - `posts`: `authorActive ==` e `at desc`;
  - `users`: `access ==` e `points desc`.
- Funções de regra:
  - `isAdmin()`: `request.auth.token.admin == true`;
  - `isActive()`: `get(users/{auth.uid}).data.access == 'active'`.

- [ ] **Passo 1: Escrever os testes que falham** com `@firebase/rules-unit-testing` (projeto `demo-letz`). Um teste por linha:
  - `users: aluno não altera access, points nem done`;
  - `users: aluno ativo lê users de outro, pendente não lê`;
  - `private: aluno não lê private de outro; treinador lê`;
  - `private/profile e billing: cliente não escreve`;
  - `ship: aluno escreve endereço mas não paidAt/track; treinador escreve paidAt/track`;
  - `handles: cria só com uid próprio e só se não existir`;
  - `cpfs: cliente não lê nem escreve`;
  - `posts: aluno ativo cria o próprio post com at == request.time`;
  - `posts: rejeita at diferente de request.time`;
  - `posts: rejeita semana trancada` (`config/app.start` no futuro e `w=1`; e `w=2` com a turma na semana 1);
  - `posts: pendente não cria`;
  - `posts: rejeita id que não seja {uid}_{w}-{d} coerente com os campos`;
  - `posts: aluno edita só comment/photoPath/imgURL do próprio; não muda hidden, rc, authorActive`;
  - `posts: treinador muda hidden`;
  - `comments: autor cria e apaga; treinador muda hidden; outro aluno não apaga`;
  - `reactions: só escreve o doc com o próprio uid`;
  - `config: ativo lê, só treinador escreve`;
  - `asaasEvents: cliente sem acesso`.
- [ ] **Passo 2: Testes do Storage** (`storage.test.js`):
  - `storage: dono envia avatars/{uid}.jpg image/jpeg 200 KB`;
  - `storage: rejeita 3 MB`;
  - `storage: rejeita content-type não imagem`;
  - `storage: rejeita caminho de outro uid`;
  - `storage: ativo lê, pendente não lê`.
- [ ] **Passo 3:** `npm run test:rules` (roda com `firebase emulators:exec --only firestore,storage`) → FAIL.
- [ ] **Passo 4:** escrever `firestore.rules` e `storage.rules`.
  - **Semana trancada:** `request.time >= get(config/app).data.start + duration.value((w-1)*7, 'd')`.
  - **Campos editáveis:** `request.resource.data.diff(resource.data).affectedKeys().hasOnly([...])`.
  - **Storage:** o Storage consulta o Firestore com `firestore.get` para `isActive()`.
- [ ] **Passo 5:** `npm run test:rules` → PASS.
- [ ] **Passo 6: Commit** — `git commit -m "regras do Firestore e Storage com testes no emulador"`

### Task 3: Functions de dados (pontos, reações, status do autor, cópia do perfil)

**Arquivos:**
- Criar:
  - `functions/package.json` (Node 22, `firebase-functions`, `firebase-admin`);
  - `functions/index.js`;
  - `functions/src/points.js`;
  - `functions/src/propagate.js`;
  - `functions/src/reactions.js`;
  - `tests/functions/data.test.js`.

**Interfaces — Consome:** `pointsFor` de `functions/shared/core.js` (copiado no predeploy e também antes dos testes, pelo script `test:functions`).
**Interfaces — Produz** (exports de `functions/index.js`, todos em `southamerica-east1`):
- `onPostWritten`: `posts/{postId}`. Recalcula `users/{uid}.points/done` com `pointsFor`, lendo todos os posts do uid e `config/app.start`.
- `onReactionWritten`: `posts/{postId}/reactions/{uid}`. Recalcula `posts/{postId}.rc` contando os documentos de reação. Usa contagem nova, para ser idempotente.
- `onUserWritten`: `users/{uid}`.
  - Se `access` mudou, grava `authorActive = (access == 'active')` em todos os posts do uid, em batch.
  - Se `name`, `handle` ou `photoURL` mudaram, copia esses campos para os posts.
- `onConfigWritten`: `config/app`. Se `start` mudou, recalcula os pontos de todos os `users` com `access == 'active'`.

- [ ] **Passo 1: Escrever os testes que falham** (emuladores de Firestore e Functions, `firebase emulators:exec`). Cada um grava dados com o Admin SDK e espera o efeito, com polling de até 10 s:
  - `points: criar 4 posts na semana 1 dá points 9 done 4`;
  - `points: apagar um post recalcula`;
  - `reactions: duas reações fire de alunos diferentes dão rc.fire 2; remover dá 1`;
  - `access: bloquear e reativar propaga authorActive`;
  - `perfil: trocar handle atualiza posts`;
  - `config: mudar start recalcula pontos`.
- [ ] **Passo 2:** `npm run test:functions` → FAIL.
- [ ] **Passo 3:** implementar os quatro triggers com `onDocumentWritten` do `firebase-functions/v2/firestore`. Batches de no máximo 500 operações.
- [ ] **Passo 4:** `npm run test:functions` → PASS.
- [ ] **Passo 5: Commit** — `git commit -m "functions: pontos, reações, status do autor e cópia do perfil"`

### Task 4: Permissão de treinador

**Arquivos:**
- Criar: `scripts/set-admin.mjs` e `tests/unit/set-admin.test.js`.

**Interfaces — Produz:** `node scripts/set-admin.mjs --project <dev|prod> --email <email> [--remove]`. O comando define ou remove a claim `admin: true` no usuário do Auth com esse e-mail, criando o usuário com senha aleatória e mandando o link de redefinição se ele não existir. Usa as credenciais ADC do dono (`gcloud auth application-default login`). O e-mail vem só do argumento e nunca é gravado em arquivo.

- [ ] **Passo 1:** teste `set-admin: define claim no emulador do Auth` (`FIREBASE_AUTH_EMULATOR_HOST`). Depois de rodar, `getUser(uid).customClaims.admin === true`. Com `--remove`, a claim vira `undefined`.
- [ ] **Passo 2:** rodar → FAIL. Implementar. Rodar → PASS.
- [ ] **Passo 3:** no **dev**, rodar o script com os e-mails que o dono informar na hora (são dois agora, e o do Uriel vem depois). Conferir no console do Auth.
- [ ] **Passo 4: Commit** — `git commit -m "script de permissão de treinador"`

### Task 5: Investigação do Asaas no sandbox e cliente da API

**Arquivos:**
- Criar:
  - `docs/asaas-notas.md`, com a decisão e os payloads reais, sem chave;
  - `functions/src/asaas.js`;
  - `tests/functions/asaas.test.js`;
  - `tests/fake-asaas.mjs`.

**Interfaces — Produz** (`functions/src/asaas.js`):
- `createClient({baseUrl, apiKey, fetchImpl})`, que retorna o cliente.
- `client.createCustomer({name, cpfCnpj, email, mobilePhone, externalReference}) → {id}`.
- `client.createCheckout({customerId, uid, value, maxInstallments, successUrl, cancelUrl, expiredUrl}) → {id, url, paymentId|null}`.
- `client.getCheckout(id) → {status, url}`.
- `classifyEvent(body) → {kind: 'paid'|'refunded'|'chargeback'|'ignore', uid: string|null, paymentId: string|null, method: string|null, installments: number|null}`. O `uid` vem de `externalReference`.
- `tests/fake-asaas.mjs`: um servidor HTTP local (porta 7777) que imita os endpoints usados e expõe `POST /__emit` para disparar webhooks durante os testes e o e2e.

- [ ] **Passo 1 (investigação, com a chave do sandbox pedida ao dono e lida de variável de ambiente, nunca gravada):** no sandbox, testar e registrar em `docs/asaas-notas.md` qual forma de cobrança atende ao mesmo tempo:
  - Pix;
  - cartão à vista;
  - cartão em até 12x **com juros pagos pelo aluno**;
  - URL de retorno para `APP_URL`;
  - `externalReference` com o uid.

  Comparar o Checkout do Asaas, os links de pagamento e a cobrança com `invoiceUrl`. Registrar também:
  - os nomes reais dos eventos de pago (Pix e cartão), reembolso e estorno, com exemplos de corpo do webhook;
  - o total e a parcela real em 12x para R$ 159,00.

  **Portão:** se nenhuma forma fizer o repasse de juros com escolha de parcelas pelo aluno, **pare e reporte ao dono** com as opções encontradas antes de seguir.
- [ ] **Passo 2: Testes que falham** em `asaas.test.js`, com `fetchImpl` falso:
  - `createCheckout envia value 159 e maxInstallments 12 e devolve url`;
  - `classifyEvent: pagamento confirmado de Pix → paid`;
  - `classifyEvent: cartão parcelado → paid com installments`;
  - `classifyEvent: reembolso → refunded`;
  - `classifyEvent: estorno → chargeback`;
  - `classifyEvent: evento desconhecido → ignore`.

  Use os corpos reais registrados no Passo 1.
- [ ] **Passo 3:** rodar → FAIL. Implementar `asaas.js` e `fake-asaas.mjs`. Rodar → PASS.
- [ ] **Passo 4: Commit** — `git commit -m "cliente do Asaas e notas do sandbox"`

### Task 6: Cadastro, retomada de pagamento e webhook

**Arquivos:**
- Criar: `functions/src/signup.js`, `functions/src/webhook.js` e `tests/functions/billing.test.js`.
- Modificar:
  - `functions/index.js`;
  - `functions/.env.letz-0-aos-5km`;
  - `functions/.env.letz-0-aos-5km-dev`;
  - `functions/.env.local`, para os emuladores: `ASAAS_BASE_URL=http://localhost:7777/v3`.

**Interfaces — Consome:** `createClient` e `classifyEvent` (Task 5); `isValidCpf`, `normalizeCpf` e `normalizePhone` (Task 1).
**Interfaces — Produz:**
- **Callable `signup({name, email, password, cpf, phone, acceptPolicy}) → {checkoutUrl}`**. Ordem:
  1. Validar os campos e conferir que `config/app.salesOpen !== false`.
  2. Reservar `cpfs/{cpf}` em transação. Se já existir com outro uid, falhar com `already-exists` e a mensagem "Este CPF já tem cadastro. Entre com seu e-mail e senha."
  3. `admin.auth().createUser`.
  4. Gravar `users/{uid}` (`access: 'pending'`, `points: 0`, `done: 0`) e `private/profile`.
  5. Criar o cliente e o checkout no Asaas e gravar `private/billing` (`status: 'pending'`).

  Se o e-mail já existir no Auth, falhar com `already-exists` e "Este e-mail já tem cadastro. Entre com seu e-mail e senha." Se o Asaas falhar depois da conta criada, mantenha a conta e o CPF com o mesmo uid e devolva `unavailable`. O cliente então faz login e usa `resumeCheckout`.
- **Callable `resumeCheckout() → {checkoutUrl}`**, só para quem está autenticado e pendente. Reaproveita o checkout se ainda estiver válido (`getCheckout`). Se não estiver, cria outro. Se `billing.status == 'paid'`, falha com `failed-precondition`.
- **HTTPS `asaasWebhook`**, em `POST`:
  - Confere o cabeçalho `asaas-access-token` contra `ASAAS_WEBHOOK_TOKEN` e responde 401 se não bater.
  - Cria `asaasEvents/{id do evento}` com `create()`. Se o documento já existir, responde 200 sem fazer nada.
  - `paid`: `users/{uid}.access='active'` e `billing.status='paid'`, mais `method`, `installments` e `paidAt`.
  - `refunded` ou `chargeback`: `access='blocked'` e `billing.status` correspondente.
  - `ignore`: 200.
  - Responde sempre 200 para eventos válidos, inclusive com `uid` desconhecido. Nesse caso, registra o erro no log.

- [ ] **Passo 1: Escrever os testes que falham** (emuladores de Auth, Firestore e Functions, mais `fake-asaas.mjs`):
  - `signup: cria conta pendente, cpf reservado e devolve checkoutUrl`;
  - `signup: CPF repetido → already-exists`;
  - `signup: e-mail repetido → already-exists`;
  - `signup: CPF inválido → invalid-argument`;
  - `signup: vendas fechadas → failed-precondition`;
  - `signup: falha no Asaas permite retomar` (o fake devolve 500 no checkout, depois `resumeCheckout` devolve a URL);
  - `resumeCheckout: pago → failed-precondition`;
  - `webhook: token errado → 401`;
  - `webhook: pago ativa conta`;
  - `webhook: evento repetido ativa uma vez só` (dois POSTs com o mesmo id; um único documento em `asaasEvents`; `access` ativo);
  - `webhook: reembolso bloqueia`.
- [ ] **Passo 2:** `npm run test:functions` → FAIL.
- [ ] **Passo 3:** implementar com `onCall`/`onRequest` do v2, `defineSecret('ASAAS_API_KEY')`, `defineSecret('ASAAS_WEBHOOK_TOKEN')` e `defineString` para os parâmetros. `successUrl` = `${APP_URL}/#/confirmando`.
- [ ] **Passo 4:** `npm run test:functions` → PASS.
- [ ] **Passo 5: Commit** — `git commit -m "cadastro, retomada de pagamento e webhook do Asaas"`

### Task 7: Front — Firebase no app, cadastro e telas de conta

**Arquivos:**
- Criar:
  - `public/js/fb.js` (módulo ES);
  - `playwright.config.mjs`, que sobe os emuladores e o `fake-asaas`, com baseURL `http://localhost:5050`;
  - `tests/e2e/auth.spec.mjs`.
- Modificar: `public/index.html`.

**Interfaces — Produz** (`window.LetzFB`, pronto quando dispara `document` → evento `letzfb-ready`). A config Web do projeto é escolhida pelo hostname: `letz-0-aos-5km.web.app` usa prod e o resto usa dev. Em `localhost`, o módulo conecta nos emuladores.
- `onSession(cb: (s: {user, claims, doc}|null) => void)`. `doc` é o `users/{uid}`, ao vivo.
- `signup(data) → Promise<{checkoutUrl}>`, que chama o callable e depois faz `signInWithEmailAndPassword`.
- `login(email, password)`, `logout()`, `resetPassword(email)`.
- `resumeCheckout() → Promise<{checkoutUrl}>`.
- `errorMessage(err) → string`, com os textos em português para: `auth/invalid-credential`, `auth/too-many-requests`, `auth/network-request-failed`, `already-exists`, `invalid-argument`, `unavailable` e `failed-precondition`.

**Mudanças no `index.html`:**
- Carregar `<script type="module" src="/js/fb.js">`.
- O `role`, que vinha do `sessionStorage`, passa a sair de `onSession`: `admin` se `claims.admin`, `athlete` se `doc.access=='active'`, `pending`, `blocked` ou `null`.
- `applyPath` espera a primeira sessão antes da guarda.
- Rotas novas:
  - `#/cadastro`;
  - `#/aguardando` (pendente, com o botão "Concluir pagamento" → `resumeCheckout`);
  - `#/confirmando` (volta do Asaas: "Confirmando seu pagamento…"; vai para Perfil/Boas-vindas/app quando `doc.access` virar `active`);
  - `#/bloqueado`;
  - `#/esqueci`.
- `vLogin` passa a pedir e-mail e senha, com links "Esqueci minha senha" e "Criar conta".
- Os botões `buy` e `to-final` vão para `#/cadastro`.
- Rota de privacidade: acrescentar `privacy:'/privacidade'` a `ROUTES` (hoje ela cai em `/`).
- **Remover:**
  - `vCheckout` e `vPaid`;
  - as rotas `/comprar` e `/compra-aprovada`;
  - `sim-paid`;
  - o código `adm123`;
  - o aviso "Versão de teste" do login;
  - `setRole` e o `sessionStorage`.
- Contato fixo nas telas `aguardando` e `bloqueado`: `letzassessoria@gmail.com` e o WhatsApp `558781908719`.
- Tela de instalação: acrescentar a explicação "No iPhone, o app da tela inicial pede para você entrar de novo com seu e-mail e senha. É só uma vez."

- [ ] **Passo 1: Escrever os testes e2e que falham** em `auth.spec.mjs`:
  - `cadastro → checkout fake → webhook pago → app` (preencher o cadastro, seguir para a URL do fake, `POST /__emit` pago e voltar para `#/confirmando`; espera Perfil);
  - `pendente que entra vê aguardando e Concluir pagamento`;
  - `bloqueado vê tela de bloqueio`;
  - `link direto #/app/feed sem login vai para #/entrar`;
  - `treinador entra e vê o painel`;
  - `senha errada mostra mensagem em português`;
  - `não existe texto "Kiwify", "teste" ou "Simular" nas telas de entrada`.
- [ ] **Passo 2:** `npm run test:e2e -- auth` → FAIL.
- [ ] **Passo 3:** implementar `fb.js` e as mudanças no `index.html`.
- [ ] **Passo 4:** `npm run test:e2e -- auth` → PASS. Também `npm run test:unit`.
- [ ] **Passo 5: Commit** — `git commit -m "front: Firebase Auth, cadastro e telas de conta"`

### Task 8: Front — dados do aluno no Firestore e fotos no Storage

**Arquivos:**
- Modificar: `public/js/fb.js` e `public/index.html`.
- Criar: `tests/e2e/athlete.spec.mjs`.

**Interfaces — Produz** (acrescentar a `LetzFB`):
- `saveProfile({name, handle, photoBlob|null})`: transação em `handles/` e `users/{uid}`; a foto vai para `avatars/{uid}.jpg`.
- `markWorkout(w, d)` e `unmarkWorkout(w, d)`. Desmarcar apaga o post, os comentários e a foto.
- `setWorkoutContent(w, d, {comment, photoBlob})` e `clearWorkoutContent(w, d, 'photo'|'comment')`.
- `watchMyPosts(cb)`.
- `watchFeed(cb, pageSize = 20)` e `loadMoreFeed()`. Consulta: `authorActive == true`, `orderBy at desc`.
- `watchRanking(cb)`: `access == 'active'`, `orderBy points desc`.
- `watchConfig(cb)`.
- `toggleReaction(postId, r)`.
- `addComment(postId, text)` e `deleteComment(postId, cid)`.
- `saveShip(addr)` e `watchShip(cb)`.

**Mudanças no `index.html`:**
- `S` deixa de ser carregado e salvo no `localStorage`. Passa a ser um cache preenchido pelos listeners, e cada `save()` vira a chamada correspondente de `LetzFB`.
- `posts()` e `ranking()` passam a ler os dados dos listeners.
- **Remover:** `SAMPLE`, `SEEDC`, `baseR` (as reações-base fictícias) e as etiquetas "exemplo" e "este aparelho".
- `resizeImg` continua comprimindo para JPEG com no máximo 900 px antes do envio.
- A medalha mostra o endereço salvo. O botão "Simular pagamento confirmado (teste)" e o aviso "Versão de teste" de `vPay` saem. O Pix copia-e-cola fica, com o texto "Depois de pagar, a confirmação aparece aqui assim que a Letz conferir o pagamento."
- Estados de carregamento e de vazio: "Carregando…" e "Ainda não há treinos da turma."

- [ ] **Passo 1: Escrever os testes e2e que falham:**
  - `perfil com foto salva e aparece no feed de outro aluno` (dois contextos de navegador);
  - `handle repetido mostra erro`;
  - `marcar treino aparece no feed e soma 3 pontos no ranking`;
  - `semana trancada não deixa marcar`;
  - `foto de treino sobe comprimida` (envia um JPEG de 4000×3000 e confere o tamanho do objeto no Storage abaixo de 2 MB);
  - `tirar foto do treino mantém o treino marcado e os pontos`;
  - `reagir e comentar aparecem para o outro aluno`;
  - `endereço da medalha persiste após recarregar`.
- [ ] **Passo 2:** rodar → FAIL. Implementar. Rodar → PASS.
- [ ] **Passo 3: Commit** — `git commit -m "front: perfil, treinos, feed, ranking e fotos no Firebase"`

### Task 9: Front — painel do treinador

**Arquivos:**
- Modificar: `public/js/fb.js` e `public/index.html`.
- Criar: `tests/e2e/admin.spec.mjs`.

**Interfaces — Produz** (acrescentar a `LetzFB`, todos só para treinador):
- `saveConfig(patch)`.
- `listAthletes(cb)`: junta `users`, `private/profile`, `private/billing` e `private/ship` de todos.
- `setAccess(uid, 'active'|'blocked')`.
- `setPostHidden(postId, bool)` e `setCommentHidden(postId, cid, bool)`.
- `setShipPaid(uid, bool)` e `setTrack(uid, code)`.

**Mudanças no `index.html` (`vAdmin`):**
- **Aba Turma:** só o campo de data, que salva em `config/app.start`. Vem com o padrão `DEFAULT_START_ISO` quando `config/app` não existe. Mais o interruptor "Vendas abertas" (`salesOpen`).
- **Remover da aba Turma:** `open-all`, `reset-start`, `end-proj` e `sim24`.
- **Aba Atletas:** tabela com nome e @, e-mail, celular, pagamento (status, forma e parcelas), acesso e o botão "Liberar acesso"/"Bloquear", treinos e pontos. Destacar quem está pendente há mais de 24 h. Remover o aviso sobre a Kiwify.
- **Aba Medalhas:** a configuração de frete e Pix (`config/app`), mais a lista de **todos** os alunos com endereço, o botão "Marcar frete pago" e o campo de rastreio.
- **Aba Feed:** esconder e restaurar posts e comentários.
- **Abas Treinos e Conteúdo:** salvam em `config/app.texts`, `videos`, `av`, `wa` e `grupo`.
- **"Ver como atleta":** pré-visualiza o app sem criar `users/{uid}`. O treinador não aparece no ranking.

- [ ] **Passo 1: Escrever os testes e2e que falham:**
  - `liberar acesso manual leva aluno pendente ao app`;
  - `bloquear tira o aluno do feed e do ranking; reativar devolve`;
  - `esconder post some o conteúdo mas mantém pontos`;
  - `marcar frete pago e rastreio aparecem para o aluno`;
  - `mudar data da turma tranca semanas para o aluno`;
  - `fechar vendas faz o cadastro mostrar vendas encerradas`;
  - `painel não mostra botões de simulação`.
- [ ] **Passo 2:** rodar → FAIL. Implementar. Rodar → PASS.
- [ ] **Passo 3: Commit** — `git commit -m "front: painel do treinador no Firebase"`

### Task 10: Textos de lançamento (o mínimo da parte 4)

**Arquivos:**
- Modificar: `public/index.html`.
- Criar: `tests/e2e/copy.spec.mjs`.

**Mudanças:**
- **Oferta:** "Pagamento seguro pela Kiwify" → "Pagamento seguro pelo Asaas · Pix ou cartão". O preço parcelado exibido vem do valor real registrado em `docs/asaas-notas.md`, nos três lugares onde aparece "12x de R$ 16,44".
- **FAQ "Como recebo o acesso?":** "Você cria sua conta com e-mail e senha, paga pelo Asaas e volta para o app com o acesso liberado assim que o pagamento é confirmado."
- **Política de privacidade:**
  - Seção 2: trocar "informados na Kiwify" por "informados no cadastro: nome, e-mail, CPF e celular". Trocar "Acesso: o código enviado ao seu e-mail" por "Acesso: e-mail e senha da sua conta".
  - Seção 5: trocar "Kiwify, que processa a compra" por "Asaas, que processa os pagamentos (Pix e cartão)".
  - Seção 7: trocar "código de uso único enviado ao seu e-mail" por "e-mail e senha".
  - Data no topo: "Atualizada em" + a data do lançamento.
- **Telas do pós-compra:** os textos que falam em "código de acesso" passam a falar em e-mail e senha.

- [ ] **Passo 1:** teste `copy.spec.mjs`: percorrer `#/`, `#/privacidade`, `#/cadastro`, `#/entrar` e `#/instalar` e confirmar que o texto renderizado não contém `Kiwify`, `código de acesso`, `teste` nem `Simular`. Rodar → FAIL.
- [ ] **Passo 2:** fazer as trocas. Rodar → PASS.
- [ ] **Passo 3: Commit** — `git commit -m "textos de lançamento: Asaas, conta com senha e política atualizada"`

### Task 11: Dev ponta a ponta com o sandbox e lançamento em produção

**Arquivos:**
- Criar: `docs/lancamento.md`, um checklist sem segredos.

- [ ] **Passo 1:** no **dev**:
  1. `firebase functions:secrets:set ASAAS_API_KEY` e `ASAAS_WEBHOOK_TOKEN`, com os valores digitados pelo dono no terminal (sandbox).
  2. `firebase deploy -P dev`.
  3. Cadastrar a URL do `asaasWebhook` do dev e o token no painel **sandbox** do Asaas.
  4. Fazer uma compra real no sandbox com Pix e outra com cartão em 12x. Conferir:
     - a conta ativa;
     - a volta para `#/confirmando` e a entrada no app;
     - o reembolso bloqueando.
- [ ] **Passo 2:** rodar `npm test` (todos os conjuntos) e anexar a saída ao `docs/lancamento.md`.
- [ ] **Passo 3:** **parar e pedir ao dono** a confirmação para produção. No **prod**, depois do ok:
  1. Habilitar o Firestore, o Storage e o Auth E-mail/Senha.
  2. Gravar os secrets de produção.
  3. `node scripts/set-admin.mjs --project prod --email <cada treinador>`.
  4. `firebase deploy -P prod`.
  5. Cadastrar o webhook no painel de **produção** do Asaas.
  6. Uma compra real de verdade (e o reembolso dela) para validar.
- [ ] **Passo 4: Commit** — `git commit -m "checklist de lançamento"`. Fazer push só com a autorização do dono.
