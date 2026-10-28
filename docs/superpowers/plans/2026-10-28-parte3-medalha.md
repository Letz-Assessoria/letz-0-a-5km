# Parte 3: medalha Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cobrar e controlar a medalha (R$ 35, Pix/cartão à vista) com modal de conclusão, endereço, status de envio manual no painel, e-mail de envio, post no feed, e a regra de reembolso (7 dias no programa, até o envio na medalha, recompra uma vez).

**Architecture:** O pedido da medalha é um documento próprio `users/{uid}/private/medal`, escrito só pelo servidor. O checkout é do Asaas, com `checkouts/{id}.kind = 'medal'`, e o mesmo `asaasWebhook` o trata sem tocar em `access`. O treinador muda o envio por uma callable de admin (única que dispara e-mail). O reembolso é manual no Asaas; o app só registra o pedido e leva ao WhatsApp.

**Tech Stack:** Cloud Functions v2 (Node 22, CommonJS, `southamerica-east1`), Firestore + rules, `nodemailer` (SMTP do Gmail), app em um único `public/index.html` (JS puro) + `public/js/fb.js`, testes `node:test` (unit, functions, rules) e Playwright.

**Spec:** `docs/superpowers/specs/2026-10-28-parte3-medalha-design.md` (aprovado pelo dono, com as mudanças de reembolso e de feed). Leia também `docs/asaas-notas.md` e os specs das partes 1 e 2.

## Global Constraints

- Preço da medalha **R$ 35,00** (`MEDAL_PRICE`, parâmetro do servidor como `PROGRAM_PRICE`), Pix ou cartão **só 1x**, taxa absorvida pela Letz. Mínimo de cobrança do Asaas: R$ 5,00.
- Regra de conclusão: **24 treinos e `10-0`, `10-1`, `10-2`** (`core.isConcluded`, em `public/lib/core.js`, copiado para `functions/shared/core.js` pelo predeploy/testes).
- Remetente de todo e-mail: **`letzassessoria@gmail.com`**, SMTP do Gmail com senha de app em **secret** `GMAIL_APP_PASSWORD` (ainda não existe). Sem o secret, o código usa transporte falso; nenhuma senha em arquivo do repositório.
- Reembolso: **7 dias corridos** do `paidAt` do programa; medalha só até `shipped`; recompra **uma vez** por produto (`refundCount < 2` pode comprar). Chargeback conta como reembolso. Reembolso é sempre manual no Asaas.
- Feed: post de medalha só com pedido `shipped` ou `delivered`; um por aluno; não conta pontos.
- Texto de usuário sempre por `esc()`. Nenhum CPF na tela. O endereço só o aluno e o treinador leem.
- Mensagens e telas em pt-BR. Functions novas exigem `allUsers` com `run.invoker` (a checagem de login/admin está no código).
- Não fazer deploy, push nem PR durante a construção; só commits na branch `feat/medalha`.
- Estados do pedido: `pending` | `paid` | `shipped` | `delivered` | `refunded`.

## Review Focus

1. Aluno que não concluiu chamando `startMedalCheckout` direto: o servidor recusa (o app só esconde o modal).
2. Pagamento duplicado da medalha (dois checkouts, evento repetido): um só `paid`, o outro vira alerta; nunca duas cobranças aceitas.
3. Reembolso chegando com o pedido já `shipped`/`delivered`: não sobrescreve rastreio nem datas; só alerta.
4. `refundCount` no limite: nem `startMedalCheckout` nem `rebuyProgram` abrem checkout, mesmo chamando a callable direto.
5. E-mail falhando (SMTP fora do ar, sem secret): o status muda mesmo assim, o erro vai para log e alerta.
6. Treinador marcando `shipped` num pedido `pending`/`refunded`, ou sem rastreio: recusado.
7. Pedido de reembolso do programa depois dos 7 dias: o servidor recusa (o app só esconde o botão).

---

### Task 1: Regra de conclusão e marcador `concluded`

**Files:**
- Modify: `public/lib/core.js` (`isConcluded`), `functions/src/points.js` (`onPostChange`), `tests/unit/core.test.js`, `tests/functions/*.test.js` (o teste de pontos existente)
- Create: nada

**Interfaces:**
- Produces: `core.isConcluded(marks: {[key:string]: number}) -> boolean`; campo `users/{uid}.concluded: boolean` (escrito só pelo servidor, volta a `false` se deixar de concluir antes de pagar a medalha).

- [ ] **Step 1: testes (falham antes).** Em `tests/unit/core.test.js`: `isConcluded` verdadeiro só com 24+ marcas **e** as três `10-0`, `10-1`, `10-2`; falso com 24+ sem `10-0`; falso com as três finais mas 23 marcas; falso para `{}`. Em `tests/functions/`: depois de marcar 24 treinos + as três finais (posts reais pelo emulador), `users/{uid}.concluded === true`; ao apagar um dos posts finais passa a `false`.
- [ ] **Step 2: rode `npm run test:unit` e o teste de functions e veja falhar.**
- [ ] **Step 3: implemente** `isConcluded` conforme a regra e, em `onPostChange` (já recalcula pontos), grave `concluded` no `users/{uid}` quando mudar (use o mesmo mapa `marks` que a função já monta a partir dos posts do aluno, **incluindo posts escondidos**).
- [ ] **Step 4: rode `npm run test:unit` e `npm run test:functions`; tudo passa.**
- [ ] **Step 5: commit** `feat: conclusão exige os três últimos dias; marcador users.concluded`.

---

### Task 2: Configuração, mailer e checkout da medalha

**Files:**
- Create: `functions/src/medal.js`, `functions/src/mailer.js`, `tests/functions/medal.test.js`
- Modify: `functions/src/billing-config.js` (param `MEDAL_PRICE`, secret `GMAIL_APP_PASSWORD`), `functions/index.js` (export `startMedalCheckout`), `functions/.env.letz-0-aos-5km`, `functions/.env.letz-0-aos-5km-dev`, `functions/.env.local` (`MEDAL_PRICE=35.00`), `tests/fake-asaas.mjs` (nada se já guarda `customerData`), `functions/package.json` (`nodemailer`)
- Test: `tests/functions/medal.test.js`

**Interfaces:**
- Produces: callable `startMedalCheckout({ useSignupAddress: boolean, address?: Address }) -> { checkoutUrl: string }` (`Address` = o de `core.cleanAddress`: cep, street, number, complement, district, city, uf); `mailer.sendMail({ to, subject, text }) -> Promise<{ sent: boolean, fake?: boolean }>` (nunca lança: devolve `{sent:false}` e loga em falha; sem `GMAIL_APP_PASSWORD` usa transporte falso e guarda a última mensagem em memória para os testes via `mailer.__lastFake()`); documento `users/{uid}/private/medal` com `status`, `address`, `checkoutId`, `url`, `expiresAt`, `refundCount` (padrão 0), `updatedAt`; `checkouts/{id}` com `kind: 'medal'`, `uid`, `value`.
- Consumes: `core.cleanAddress`, `core.isConcluded`, `customerDataOf` de `billing-config.js` (estender para aceitar um endereço explícito), `asaasClient().createCheckout`.

- [ ] **Step 1: testes (falham).** Em `tests/functions/medal.test.js` (siga o estilo de `billing.test.js`: helpers `call`, `person`, `signupOk`, emulador + Asaas falso): (a) aluno ativo e concluído (semeie `users/{uid}.concluded` e os posts) chama com `useSignupAddress:true` → 1 checkout no fake com `items[0].value === 35`, `chargeTypes` só `DETACHED`, sem `installment`, `customerData.address` do cadastro, `medal.status==='pending'`, `checkouts/{id}.kind==='medal'`; (b) com `address` novo e `useSignupAddress:false` usa o endereço novo e grava em `medal.address`; (c) não concluído, não ativo, anônimo → recusado e **nenhum checkout** no fake; (d) já `paid`/`shipped` → `failed-precondition`; (e) segunda chamada com checkout `pending` válido → devolve a mesma URL, sem novo checkout; (f) `refundCount >= 2` → recusado; (g) endereço inválido → `invalid-argument`; (h) conclusão conferida nos **posts** (aluno com `concluded:true` forjado no doc mas sem posts → recusado).
- [ ] **Step 2: rode `npm run test:functions` e veja falhar.**
- [ ] **Step 3: implemente** `functions/src/medal.js` (exporta `startMedalCheckout(request)`), `mailer.js` e os params. O servidor recalcula a conclusão lendo os posts do aluno (como em Task 1), nunca confia no marcador. O endereço do cadastro vem de `private/profile.address`; sem ele e com `useSignupAddress:true` → `invalid-argument`. O valor vem só de `MEDAL_PRICE`. `successUrl` volta para `${APP_URL}/#/medalha` e `cancelUrl` para `${APP_URL}/#/app/fim`. Rate limit: reutilize `rateLimit` de `signup.js` se for simples de exportar; senão, nenhum.
- [ ] **Step 4: rode os testes; passam.**
- [ ] **Step 5: commit** `feat: checkout da medalha (R$ 35, 1x), mailer e params`.

---

### Task 3: Webhook da medalha, reembolsos e `refundCount`

**Files:**
- Modify: `functions/src/webhook.js`, `tests/functions/billing.test.js` ou `tests/functions/medal.test.js`
- Test: `tests/functions/medal.test.js`

**Interfaces:**
- Consumes: `checkouts/{id}.kind`, `users/{uid}/private/medal`, `classifyEvent` existente (`kind: 'paid'|'refunded'|'chargeback'|'rejected'|'partial-refund'`).
- Produces: eventos de **checkout de medalha** não tocam `users.access` nem `private/billing`; efeitos abaixo; `private/billing.refundCount` e `private/medal.refundCount` (incrementados em reembolso total/chargeback/rejeição); tipos de alerta novos: `medal-duplicate`, `medal-refunded-shipped`, `medal-partial-refund`.

- [ ] **Step 1: testes (falham).** Com um pedido `pending` e o webhook: (a) `PAYMENT_RECEIVED` do checkout da medalha → `medal.status==='paid'`, `paidAt`, `users.access` **inalterado**, linha em `payments/{checkoutId}` com `product: 'Medalha Letz bora!'` e `kind: 'medal'`; evento repetido não duplica; (b) segundo pagamento de **outro** checkout de medalha do mesmo aluno já `paid` → alerta `medal-duplicate`, status continua; (c) reembolso total com `paid` → `refunded`, `refundCount` 1, sem alerta; (d) reembolso com `shipped` e `delivered` → status, rastreio e datas **iguais**, `refundCount` +1, alerta `medal-refunded-shipped`; (e) reembolso parcial → alerta `medal-partial-refund`, nada mais; (f) reembolso do **programa** incrementa `billing.refundCount` e bloqueia como hoje; (g) um erro ao montar a parte da medalha não impede o evento do programa (pagamento de programa continua ativando). (h) **separação programa/medalha (achado da revisão de segurança):** `CHECKOUT_PAID` e `PAYMENT_*` de um checkout `kind:'medal'` — inclusive com `externalReference` igual ao uid, como no programa — **nunca** mudam `private/billing` nem `users.access`, mesmo que o billing do programa esteja `pending`, `refunded` ou `blocked`; e um pagamento do **programa** nunca marca a medalha. O ramo da medalha vem **antes** de qualquer lógica de billing do programa em `processEvent`, decidido por `checkouts/{id}.kind` (e, se o checkout não for nosso, sem efeito).
- [ ] **Step 2: rode os testes; falham.**
- [ ] **Step 3: implemente** o ramo `kind === 'medal'` em `processEvent` antes de `applyPaid/applyClosed` (leia `checkouts/{id}` já lido; mantenha todas as leituras antes das escritas e a idempotência por `asaasEvents`). Reaproveite `writePayment` com produto/`kind` parametrizados.
- [ ] **Step 4: rode `npm run test:functions`; tudo passa (os testes antigos de webhook incluídos).**
- [ ] **Step 5: commit** `feat: webhook trata a medalha (pago, reembolso, duplicado) e conta reembolsos`.

---

### Task 4: Regras do Firestore para a medalha e o post da medalha

**Files:**
- Modify: `firestore.rules`, `tests/rules/firestore.test.js`, `functions/src/points.js` (ignorar post de medalha nos pontos e no marcador), `scripts/make-test-rules.mjs` (só se necessário)
- Test: `tests/rules/firestore.test.js`

**Interfaces:**
- Produces: `users/{uid}/private/medal`: leitura do dono e do treinador, escrita `false` para clientes; post de medalha em `posts/{uid}_medal` (campos de `newPostOk` sem `w`/`d`, mais `medal: true`), criável só pelo dono com pedido `shipped`/`delivered`, sem pontos, `hidden` pelo treinador como os outros.

- [ ] **Step 1: testes de regra (falham).** Dono e treinador leem `private/medal`; outro aluno e anônimo não; ninguém grava pelo cliente; dono cria `posts/{uid}_medal` com `medal:true` quando o pedido está `shipped` e quando `delivered`, **recusado** com `paid`, `pending` e `refunded`; segundo create do mesmo id é negado (um por aluno); `w`/`d` inválidos continuam negados nos posts de treino; o post de medalha pode ter `comment`, `imgURL` do bucket do projeto, `photoPath == 'workouts/{uid}/medal.jpg'`.
- [ ] **Step 2: rode `npm run test:rules`; falha.**
- [ ] **Step 3: implemente** as regras (função `medalPostOk()` separada de `newPostOk()`); em `points.js`, ignore posts com `medal == true` (e o id `_medal`) em pontos, `done` e `concluded`. Storage: `storage.rules` precisa aceitar `workouts/{uid}/medal.jpg` (JPEG ≤ 2 MB) para o dono quando o pedido está `shipped`/`delivered` (mesma consulta cruzada que o resto).
- [ ] **Step 4: rode `npm run test:rules` e `npm run test:functions`; passam.**
- [ ] **Step 5: commit** `feat: regras da medalha e do post da medalha`.

---

### Task 5: Callables do treinador e e-mail de envio

**Files:**
- Create/Modify: `functions/src/medal.js` (acrescenta `updateMedalOrder`, `resendMedalEmail`), `functions/index.js`, `tests/functions/medal.test.js`
- Test: `tests/functions/medal.test.js`

**Interfaces:**
- Produces: `updateMedalOrder({ uid, status: 'paid'|'shipped'|'delivered', trackingCode?: string, shippedAt?: string(ISO date), deliveredAt?: string(ISO date) }) -> { ok: true, emailed: boolean }` só admin; `resendMedalEmail({ uid }) -> { ok: true, emailed: boolean }` só admin; `mailer.sendMail` do Task 2.
- Transições válidas: `paid→shipped`, `shipped→delivered`; volta de um passo: `delivered→shipped`, `shipped→paid` (sem e-mail); `pending` e `refunded` nunca vão para `shipped`/`delivered`. `shipped` exige `trackingCode` (3 a 40 caracteres, `[A-Za-z0-9-]`) e `shippedAt` (padrão: hoje). `delivered` aceita `deliveredAt` (padrão: hoje).

- [ ] **Step 1: testes (falham).** Só admin (aluno, anônimo → `permission-denied`); `paid→shipped` sem rastreio → `invalid-argument`; `paid→shipped` com rastreio → status, `trackingCode`, `shippedAt`, e-mail enviado **uma vez** (`mailer.__lastFake()` com nome do aluno, rastreio, data e endereço, sem dado de pagamento; assunto e remetente `letzassessoria@gmail.com`); editar rastreio de `shipped` não reenvia; `shipped→paid` e `delivered→shipped` sem e-mail; `pending→shipped` e `refunded→delivered` → `failed-precondition`; falha forçada do mailer → o status **muda** mesmo assim, `emailed:false` e um alerta `medal-email-failed`; `resendMedalEmail` só para `shipped`/`delivered`.
- [ ] **Step 2: rode; falha.**
- [ ] **Step 3: implemente** (texto do e-mail em pt-BR curto: saudação com o nome, "sua medalha foi enviada", rastreio, data, endereço, e uma linha de contato com a assessoria).
- [ ] **Step 4: rode `npm run test:functions`; passa.**
- [ ] **Step 5: commit** `feat: treinador atualiza o envio da medalha e e-mail ao aluno`.

---

### Task 6: Pedido de reembolso e recompra do programa

**Files:**
- Modify: `functions/src/signup.js` (reaproveite `openCheckout`; não duplique), `functions/src/medal.js` (`requestRefund`), `functions/index.js`, `tests/functions/billing.test.js` ou `tests/functions/medal.test.js`
- Test: `tests/functions/medal.test.js`

**Interfaces:**
- Produces: `requestRefund({ product: 'program'|'medal' }) -> { ok: true }` (grava `refundRequestedAt` no `billing` ou no `medal`; idempotente por dia); `rebuyProgram() -> { checkoutUrl: string }`.
- Regras: `requestRefund('program')` só com `billing.status === 'paid'` e `now - paidAt <= 7 dias`; `requestRefund('medal')` só com `medal.status === 'paid'`; fora disso `failed-precondition`. `rebuyProgram` só com `billing.status` em `refunded`/`chargeback`/`rejected`, `billing.refundCount < 2` e conta existente; reabre `billing.status = 'pending'` (acesso continua `blocked` até pagar), cria checkout do mesmo preço do programa (sem cupom). `startMedalCheckout` (Task 2) já respeita `medal.refundCount`.

- [ ] **Step 1: testes (falham).** Pedido de reembolso do programa com `paidAt` há 3 dias → ok e `refundRequestedAt` gravado; há 8 dias → recusado; sem pagamento → recusado; da medalha `paid` → ok, `shipped` → recusado; `rebuyProgram` após reembolso com `refundCount 1` → checkout novo, `billing.status pending`, `access` ainda `blocked`; com `refundCount 2` → recusado e **nenhum checkout** no fake; conta nunca reembolsada → recusado; pago o novo checkout (webhook) o acesso volta.
- [ ] **Step 2: rode; falha.**
- [ ] **Step 3: implemente.** O prazo de 7 dias usa `Date.now()`; os testes semeiam `paidAt` diretamente.
- [ ] **Step 4: rode `npm run test:functions`; passa.**
- [ ] **Step 5: commit** `feat: pedido de reembolso e recompra do programa (limite uma vez)`.

---

### Task 7: App do aluno: modal, endereço, pagamento, tela da medalha, reembolso

**Files:**
- Modify: `public/index.html` (substitui `vFim`/`shipBox`/`shipStatus`/Pix manual: `S.ship`, `pay-open`, `pixPayload`, `vShip`, campos `frete`, `chave`, `pnome`, `pcidade`), `public/js/fb.js` (`startMedalCheckout`, `watchMedal`, `requestRefund`, `rebuyProgram`; remova `saveShip`, `watchShip`, `setShipPaid`, `setTrack`), `tests/e2e/athlete.spec.mjs`, `tests/e2e/helpers.mjs`
- Test: `tests/e2e/athlete.spec.mjs` (novo grupo "medalha")

**Interfaces:**
- Consumes: callables das Tasks 2 e 6; `users/{uid}.concluded`; `private/medal`; `config/app.wa` (link do WhatsApp da assessoria, já usado em `waLink()`).
- Produces: rota `#/medalha` (volta do Asaas, "confirmando" que vira a tela de status); modal com **Continuar** / **Depois**; passo de endereço com opção **"Usar o endereço do cadastro"** (linha com rua, bairro, cidade/UF, número) ou **"Informar outro"** (CEP/ViaCEP como no cadastro, `vCadAddr`); botão **"Solicitar reembolso"** com contador no programa (dentro de 7 dias do `paidAt`) e na medalha enquanto `paid`; WhatsApp com mensagem pré-preenchida (`https://wa.me/...?text=`) a partir do `waLink()` existente; na tela "Bloqueado", **"Comprar de novo"** (se `refundCount < 2`) ou só "Falar com a assessoria".

- [ ] **Step 1: e2e (falham).** Aluno concluído (semeie 24+3 pelo `helpers`): o modal aparece ao abrir o app; **Depois** o fecha e o aviso continua acessível na aba de fim; **Continuar** mostra o endereço do cadastro numa linha; "Informar outro" abre os campos; confirmar leva ao checkout do Asaas fake com valor 35; depois do webhook, `#/medalha` mostra "Pago, aguardando envio"; com `shipped` mostra rastreio e a data; aluno **não** concluído não vê modal nem consegue abrir o checkout; botão de reembolso do programa mostra "faltam N dias" (semeie `paidAt`), abre o link do WhatsApp (intercepte `window.open`/navegação) e depois de 8 dias vira "Falar com a assessoria"; conta reembolsada vê "Comprar de novo" (e só o contato com `refundCount 2`); layout em 390 px sem scroll horizontal.
- [ ] **Step 2: rode o e2e dos novos testes; falham.**
- [ ] **Step 3: implemente** a UI seguindo `vCadAddr`/`vCadastro` (visual e escape), apague o fluxo antigo por inteiro. Todos os textos novos passam por `esc()`.
- [ ] **Step 4: rode `npx playwright test tests/e2e/athlete.spec.mjs tests/e2e/auth.spec.mjs`; passa (ajuste os testes antigos que cobriam o Pix manual/ship, removendo-os).**
- [ ] **Step 5: commit** `feat: modal, endereço, pagamento e status da medalha no app; reembolso`.

---

### Task 8: Post da medalha no feed

**Files:**
- Modify: `public/js/fb.js` (`postMedal({ comment, photoBlob })`, `watchMyMedalPost`), `public/index.html` (formulário na tela da medalha e selo "Medalha" no feed), `tests/e2e/athlete.spec.mjs`
- Test: `tests/e2e/athlete.spec.mjs`

**Interfaces:**
- Consumes: regras e storage da Task 4; `private/medal.status`.
- Produces: botão **"Postar no feed"** na tela da medalha **só** com `shipped`/`delivered` e sem post de medalha ainda; post no feed com selo "Medalha"; sem pontos; o treinador esconde como qualquer post.

- [ ] **Step 1: e2e (falha).** Com `paid` não há botão; com `shipped` aparece, posta foto+comentário, o selo "Medalha" aparece no feed de outro aluno e o ranking/pontos não mudam; segundo post indisponível; treinador esconde e some do feed dos alunos.
- [ ] **Step 2: rode; falha.** **Step 3: implemente** reusando o formulário e o redimensionamento de imagem do treino. **Step 4: rode; passa.**
- [ ] **Step 5: commit** `feat: post da medalha no feed`.

---

### Task 9: Painel do treinador: aba Medalhas, Financeiro e Atletas

**Files:**
- Modify: `public/index.html` (aba `medalhas` do `vAdmin`, `finSales`/Vendas, Atletas), `public/js/fb.js` (`listMedalOrders`, `updateMedalOrder`, `resendMedalEmail`), `tests/e2e/admin.spec.mjs`
- Test: `tests/e2e/admin.spec.mjs`

**Interfaces:**
- Consumes: `users.concluded`, `private/medal`, callables da Task 5, `payments` com `kind: 'medal'`.
- Produces: aba **Medalhas** (substitui "Frete por Pix"): contadores (Concluiu e não comprou · Pago, aguardando envio · Enviado · Entregue · Reembolsado), filtro por status, busca por nome, uma linha por aluno que concluiu com status, data do pagamento, rastreio, datas, **endereço completo com botão copiar**, marca de pedido de reembolso e `refundCount`; ações **Marcar enviado** (rastreio + data, padrão hoje), **Marcar entregue**, voltar um passo, **Reenviar e-mail**; erros da callable em `role="alert"`. No Financeiro as vendas de medalha saem como produto "Medalha" e **não** entram em KPIs do programa (receita, ticket médio). Em Atletas, marca "pediu reembolso" e `refundCount`.

- [ ] **Step 1: e2e (falha).** Treinador vê concluído-não-comprou, marca `paid→shipped` com rastreio (o e-mail falso é capturado pelo teste via `mailer.__lastFake` exposto pelo emulador de forma simples: um endpoint de debug do **emulador** apenas, ou verifique o alerta/documento `medal.emailedAt` se o endpoint for desnecessário), vê contadores mudarem, copia o endereço, volta um passo, tenta marcar enviado sem rastreio e vê o erro; venda de medalha não aparece em "ticket médio"; busca e filtro funcionam; 390 px sem scroll horizontal (o painel já é largo; só garanta a tabela rolável).
- [ ] **Step 2: rode; falha. Step 3: implemente** (visual e `esc()` como nas abas existentes, sem poluir). **Step 4: rode `npx playwright test tests/e2e/admin.spec.mjs`; passa.**
- [ ] **Step 5: commit** `feat: painel de medalhas, vendas de medalha e pedidos de reembolso`.

---

### Task 10: Textos, documentação e fechamento

**Files:**
- Modify: `public/index.html` (landing "frete à parte", FAQ "Como recebo a medalha?", política: endereço de entrega e e-mail), `docs/lancamento.md` (secret `GMAIL_APP_PASSWORD`, `MEDAL_PRICE`, novas Functions com `allUsers`, e-mail), `docs/melhorias-pos-lancamento.md`, `tests/e2e/copy.spec.mjs`
- Test: `tests/e2e/copy.spec.mjs`

- [ ] **Step 1: teste (falha)** de copy: landing/FAQ dizem "R$ 35,00", "frete", "Pix ou cartão à vista" e **não** "frete à parte" nem "Pix manual"; política cita o e-mail de envio e o endereço.
- [ ] **Step 2: rode; falha. Step 3: ajuste os textos e os docs** (o secret é criado pelo dono: `firebase functions:secrets:set GMAIL_APP_PASSWORD`; sem ele o envio real fica desligado, o fake roda).
- [ ] **Step 4: rode as suítes completas: `npm run test:unit`, `test:rules`, `test:functions`, `test:admin`, e o e2e inteiro; todas passam.**
- [ ] **Step 5: commit** `docs: textos da medalha, secret do Gmail e checklist de lançamento`.
