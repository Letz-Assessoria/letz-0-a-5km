# Notas do Asaas (sandbox, 27/10/2026)

Investigação do passo 1 da task 5. Tudo foi testado no **sandbox** (`https://api-sandbox.asaas.com/v3`), com a chave lida de variável de ambiente. Nenhuma chave aparece aqui.

## Resultado do portão: BLOQUEADO

Nenhuma das três formas de cobrança hospedadas pelo Asaas cobra **juros do parcelamento do aluno**. Em todas, o parcelamento no cartão é **sem juros para o comprador**: 12x de R$ 13,25 = R$ 159,00, e a taxa do cartão sai do valor que a Letz recebe. O requisito "até 12x com juros pagos pelo aluno, escolhendo as parcelas na página do Asaas" não é atendido. A decisão volta para o dono (opções no fim).

## Requisitos × formas de cobrança

| Requisito | Checkout (`POST /checkouts`) | Link de pagamento (`POST /paymentLinks`) | Cobrança com `invoiceUrl` (`POST /payments`, `billingType: UNDEFINED`) |
|---|---|---|---|
| Pix | sim | sim (também mostra boleto) | sim (também boleto e débito) |
| Cartão à vista | sim | sim | sim |
| Aluno escolhe de 1x a 12x | sim (`installment.maxInstallmentCount: 12`) | sim (`maxInstallmentCount: 12`) | **não**: a fatura avulsa é só 1x; parcelada exige `installmentCount` fixo na criação |
| Juros pagos pelo aluno | **não** (página: "Pagar em 12x de R$ 13,25") | **não** (página: "em até 12x de R$ 13,25 **sem juros**") | **não** |
| URL de retorno | sim, `callback.successUrl/cancelUrl/expiredUrl`, **sem exigência de domínio** | sim, `callback.successUrl`, mas **tem que ser do domínio cadastrado em Minha Conta > Informações** (o sandbox tem `http://localhost:3000`, e `localhost` é recusado como inválido) | igual ao link |
| `externalReference` com o uid | sim, no checkout (volta no `CHECKOUT_PAID`), **mas não é copiado para as cobranças** geradas | sim no link | sim na cobrança |

Fontes: testes no sandbox (respostas abaixo) e docs oficiais (`docs.asaas.com/reference/criar-novo-checkout`, `/reference/criar-um-link-de-pagamentos`, `/reference/criar-nova-cobranca`, `/docs/faq-do-asaas-checkout`). Nenhum desses endpoints tem campo de juros de parcelamento. O campo `interest` de `/payments` é **juros de mora** (atraso), não de parcelamento. Os únicos "juros por parcela" da documentação estão nos **plugins** WooCommerce e Nuvemshop (`/docs/forma-de-pagamento`), que montam o checkout da própria loja e criam a cobrança com o valor já acrescido. Uma resposta oficial do Asaas no blog (comentário em `blog.asaas.com/link-para-pagamento-parcelado`, 31/07/2023) diz: "Pelo link de pagamento não é possível gerar cobranças parceladas com juros", e que o repasse da taxa "deve ser feito durante o processo de compra".

## Valores reais para R$ 159,00 (sandbox)

`POST /payments/simulate` com `{"value":159,"installmentCount":12,"billingTypes":["CREDIT_CARD","PIX"]}`:

| Forma | Aluno paga | Parcela | Letz recebe (líquido) | Taxa |
|---|---|---|---|---|
| Cartão 12x | R$ 159,00 | **R$ 13,25** | R$ 152,28 | 3,99% + R$ 0,49 |
| Cartão 1x | R$ 159,00 | R$ 159,00 | R$ 153,76 | 2,99% + R$ 0,49 |
| Pix | R$ 159,00 | — | R$ 157,01 (cobrança real) | R$ 1,99 fixo |

Taxas da conta (`GET /myAccount/fees`, `creditCard`): 1x 2,99%; 2–6x 3,49%; 7–12x 3,99%; 13–21x 4,29%; mais R$ 0,49 por operação. O dinheiro do cartão cai em 32 dias (`daysToReceive`), parcela a parcela.

A landing diz "12x de R$ 16,44" (total R$ 197,28, taxa implícita de cerca de 3,49% ao mês, Tabela Price). **Esse número não existe no Asaas.** Na página do Asaas o aluno vê 12x de R$ 13,25.

Pagamento real feito no sandbox pelo Checkout (cartão de teste 4444 4444 4444 4444, 12x): parcelamento `1e7dbfdd-…` com `value 159.00`, `paymentValue 13.25`, `installmentCount 12`, `netValue 152.28`.

## Comportamentos do Checkout que afetam o desenho

1. **`customer` existente exige endereço.** `POST /checkouts` com `customer: cus_…` sem endereço volta 400 ("O campo address deve existir para o customer informado", idem `addressNumber`, `postalCode`, `province`, `city`). `customerData` também exige endereço. Sem `customer`/`customerData`, o checkout é criado e a página pede **identificação (e-mail, nome, CPF, celular) e endereço completo** ao aluno.
2. **Cada checkout pago cria um cliente novo** no Asaas (vimos `cus_000009700317` e `cus_000009700335` para o mesmo CPF). Então `createCustomer` só serve se passarmos a coletar endereço no cadastro.
3. **Não há `GET /checkouts/{id}`.** A API só tem criar e cancelar (`POST /checkouts/{id}/cancel`). `GET /checkouts/{id}` responde 404. O estado vem pelos webhooks (`CHECKOUT_PAID`, `CHECKOUT_EXPIRED`, `CHECKOUT_CANCELED`) ou pela validade (`minutesToExpire`, de 10 a 1440 min) guardada por nós.
4. **O uid não vem nos eventos de cobrança.** Em `PAYMENT_*` o `payment.externalReference` chega `null`. O vínculo é `payment.checkoutSession` = id do checkout. Para achar o uid: guardar `checkoutId → uid` ao criar o checkout, ou usar o `CHECKOUT_PAID`, que traz `checkout.externalReference`, mas não traz id da cobrança, forma de pagamento nem parcelas.
5. **Item exige `imageBase64`** (obrigatório) e `name` até 30 caracteres.
6. **Pix exige chave Pix na conta.** Sem ela: 400 "Para gerar cobranças com Pix é necessário criar uma chave Pix no Asaas". Criei uma chave EVP no sandbox (`POST /pix/addressKeys`). Em produção, o dono precisa ter uma chave cadastrada.
7. O `link` vem pronto na resposta: `https://sandbox.asaas.com/000/checkoutSession/show/{id}` (produção: `https://www.asaas.com/checkoutSession/show/{id}`, a conferir).

## Eventos do webhook (capturados de verdade)

Os eventos foram capturados com um webhook temporário no sandbox apontando para um receptor local via túnel. O webhook foi removido depois. O Asaas envia o cabeçalho `asaas-access-token` com o token cadastrado (conferido: presente em todos). O token precisa ter 32 caracteres ou mais e não pode ter números em sequência. `sendType` válido: `SEQUENTIALLY`.

| Situação | Sequência observada |
|---|---|
| Cartão 12x pelo Checkout | `CHECKOUT_PAID` (1x) + `PAYMENT_CREATED` ×12 (já `CONFIRMED`) + `PAYMENT_CONFIRMED` ×12, um por parcela (`installmentNumber` 1..12, `value 13.25`, mesmo `installment`). `PAYMENT_RECEIVED` só quando cada parcela for creditada (+32 dias). |
| Pix pelo Checkout | `PAYMENT_CREATED` (`PENDING`, ao clicar "Pagar com pix") → `CHECKOUT_PAID` → `PAYMENT_RECEIVED` (`RECEIVED`). **Pix não gera `PAYMENT_CONFIRMED`.** (Confirmado via `POST /sandbox/payment/{id}/confirm`, só no sandbox.) |
| Estorno do parcelamento (`POST /installments/{id}/refund`) | `PAYMENT_REFUNDED` ×12, um por parcela, `status REFUNDED`, `refunds[0].status DONE`. |
| Estorno de Pix (`POST /payments/{id}/refund`) | Ficou em `refunds[0].status: AWAITING_CRITICAL_ACTION_AUTHORIZATION` (exige autorização de evento crítico no painel). Nenhum evento chegou. Pela doc, depois sai `PAYMENT_REFUND_IN_PROGRESS` e então `PAYMENT_REFUNDED`. |
| Chargeback | **Não dá para simular no sandbox.** Pela doc: `PAYMENT_CHARGEBACK_REQUESTED` (recebido), `PAYMENT_CHARGEBACK_DISPUTE`, `PAYMENT_AWAITING_CHARGEBACK_REVERSAL`. O corpo traz `payment.chargeback: {status: "REQUESTED", reason: "…"}`. |

Classificação sugerida:
- pago: `PAYMENT_CONFIRMED` (cartão) e `PAYMENT_RECEIVED` (Pix; no cartão chega depois e repete). `CHECKOUT_PAID` também serve como sinal de pago e traz o uid.
- reembolsado: `PAYMENT_REFUNDED`. `PAYMENT_PARTIALLY_REFUNDED` e `PAYMENT_REFUND_IN_PROGRESS` a decidir.
- estorno (chargeback): `PAYMENT_CHARGEBACK_REQUESTED` (e `PAYMENT_CHARGEBACK_DISPUTE`).
- ignorar: o resto (`PAYMENT_CREATED`, `PAYMENT_UPDATED`, `CHECKOUT_CREATED`, `CHECKOUT_EXPIRED`…).
- Idempotência: o `id` do evento (`evt_…&nnn`) e, no cartão parcelado, agrupar pelo `payment.installment` (12 eventos para uma compra).

### Corpos reais (sandbox; `account.id` e `creditCardToken` omitidos)

`PAYMENT_CONFIRMED`, cartão, parcela 1 de 12:

```json
{"id":"evt_15e444ff9b9ab9ec29294aa1abe68025&23472348","event":"PAYMENT_CONFIRMED","dateCreated":"2026-10-27 10:00:32","account":{"id":"<conta-sandbox>","ownerId":null},
 "payment":{"object":"payment","id":"pay_5abeog1boszmcyki","dateCreated":"2026-10-27","customer":"cus_000009700317","installment":"1e7dbfdd-d86d-46dc-82a8-ba347835a5c6","checkoutSession":"121ab2db-988e-4418-9d5d-45a58638ba01","paymentLink":null,"value":13.25,"netValue":12.69,"originalValue":null,"interestValue":null,"description":"Parcela 1 de 12.","billingType":"CREDIT_CARD","confirmedDate":"2026-10-27","creditCard":{"creditCardNumber":"4444","creditCardBrand":"VISA","creditCardToken":"<omitido>"},"pixTransaction":null,"status":"CONFIRMED","dueDate":"2026-10-27","originalDueDate":"2026-10-27","paymentDate":null,"clientPaymentDate":"2026-10-27","installmentNumber":1,"invoiceUrl":"https://sandbox.asaas.com/i/5abeog1boszmcyki","invoiceNumber":"19566003","externalReference":null,"deleted":false,"anticipated":false,"anticipable":true,"creditDate":"2026-11-30","estimatedCreditDate":"2026-11-30","transactionReceiptUrl":"https://sandbox.asaas.com/000/comprovantes/7234114067600573","nossoNumero":null,"bankSlipUrl":null,"lastInvoiceViewedDate":null,"lastBankSlipViewedDate":null,"discount":{"value":0,"limitDate":null,"dueDateLimitDays":0,"type":"FIXED"},"fine":{"value":0,"type":"FIXED"},"interest":{"value":0,"type":"PERCENTAGE"},"postalService":false,"escrow":null,"refunds":null}}
```

`PAYMENT_RECEIVED`, Pix:

```json
{"id":"evt_d26e303b238e509335ac9ba210e51b0f&23472678","event":"PAYMENT_RECEIVED","dateCreated":"2026-10-27 10:01:40","account":{"id":"<conta-sandbox>","ownerId":null},
 "payment":{"object":"payment","id":"pay_55jz1por0iil4o4h","dateCreated":"2026-10-27","customer":"cus_000009700335","checkoutSession":"97d20bc1-7ede-4f70-9e5c-8e80f6dad160","paymentLink":null,"value":159,"netValue":157.01,"originalValue":null,"interestValue":null,"description":null,"billingType":"PIX","confirmedDate":"2026-10-27","pixTransaction":"b4974465-9c7c-4f95-838f-22c7f38b3e2a","pixQrCodeId":"951245cd-6f21-48b0-8a42-5ae3d1566c36","status":"RECEIVED","dueDate":"2026-10-27","originalDueDate":"2026-10-27","paymentDate":"2026-10-27","clientPaymentDate":"2026-10-27","installmentNumber":null,"invoiceUrl":"https://sandbox.asaas.com/i/55jz1por0iil4o4h","invoiceNumber":"19566132","externalReference":null,"deleted":false,"anticipated":false,"anticipable":false,"creditDate":"2026-10-27","estimatedCreditDate":"2026-10-27","transactionReceiptUrl":"https://sandbox.asaas.com/000/comprovantes/h/UEFZTUVOVF9SRUNFSVZFRDpwYXlfNTVqejFwb3IwaWlsNG80aA%3D%3D","nossoNumero":null,"bankSlipUrl":null,"lastInvoiceViewedDate":null,"lastBankSlipViewedDate":null,"discount":{"value":0,"limitDate":null,"dueDateLimitDays":0,"type":"FIXED"},"fine":{"value":0,"type":"FIXED"},"interest":{"value":0,"type":"PERCENTAGE"},"postalService":false,"escrow":null,"refunds":null}}
```

`PAYMENT_REFUNDED`, cartão, parcela 1 de 12 (igual ao `PAYMENT_CONFIRMED`, exceto):

```json
{"id":"evt_d313266b1bd58128da69a2a96d82e79e&23472839","event":"PAYMENT_REFUNDED","dateCreated":"2026-10-27 10:01:57",
 "payment":{"id":"pay_5abeog1boszmcyki","installment":"1e7dbfdd-d86d-46dc-82a8-ba347835a5c6","checkoutSession":"121ab2db-988e-4418-9d5d-45a58638ba01","value":13.25,"billingType":"CREDIT_CARD","status":"REFUNDED","installmentNumber":1,"externalReference":null,"anticipable":false,"transactionReceiptUrl":"https://sandbox.asaas.com/000/comprovantes/6594222694555618",
 "refunds":[{"dateCreated":"2026-10-27 10:01:52","status":"DONE","value":13.25,"endToEndIdentifier":null,"transactionReceiptUrl":"https://sandbox.asaas.com/000/comprovantes/6594222694555618","description":null,"refundedSplits":null}]}}
```

`CHECKOUT_PAID` (Pix; o do cartão é igual, com o outro id e `externalReference`):

```json
{"id":"evt_20f793f686aa4783d486a40e3c6b91d1&23472664","event":"CHECKOUT_PAID","dateCreated":"2026-10-27 10:01:39","account":{"id":"<conta-sandbox>","ownerId":null},
 "checkout":{"id":"97d20bc1-7ede-4f70-9e5c-8e80f6dad160","link":"https://sandbox.asaas.com/000/checkoutSession/show/97d20bc1-7ede-4f70-9e5c-8e80f6dad160","status":"PAID","minutesToExpire":60,"externalReference":"uid-teste-pix-002","billingTypes":["PIX","CREDIT_CARD"],"chargeTypes":["DETACHED","INSTALLMENT"],"callback":{"cancelUrl":"https://letz-0-aos-5km-dev.web.app/#/pagamento?c=cancel","successUrl":"https://letz-0-aos-5km-dev.web.app/#/pagamento","expiredUrl":"https://letz-0-aos-5km-dev.web.app/#/pagamento?c=expired"},"items":[{"name":"Do 0 aos 5 km","description":"Programa de corrida (TESTE)","externalReference":null,"quantity":1,"value":159}],"subscription":null,"installment":{"maxInstallmentCount":12},"split":null,"customer":null,"customerData":null}}
```

`PAYMENT_CHARGEBACK_REQUESTED`: não simulável no sandbox. É o mesmo formato de `payment`, com `"chargeback": {"status": "REQUESTED", "reason": "PROCESS_ERROR"}` (exemplo da doc `/docs/webhook-para-cobrancas`).

### Requisição que funcionou (Checkout)

```json
POST /v3/checkouts
{"billingTypes":["PIX","CREDIT_CARD"],"chargeTypes":["DETACHED","INSTALLMENT"],"minutesToExpire":60,
 "externalReference":"<uid>",
 "callback":{"successUrl":"<APP_URL>/#/pagamento","cancelUrl":"<APP_URL>/#/pagamento?c=cancel","expiredUrl":"<APP_URL>/#/pagamento?c=expired"},
 "installment":{"maxInstallmentCount":12},
 "items":[{"name":"Do 0 aos 5 km","description":"…","quantity":1,"value":159.00,"imageBase64":"<png em base64>"}]}
→ 200 {"id":"121ab2db-…","link":"https://sandbox.asaas.com/000/checkoutSession/show/121ab2db-…","status":"ACTIVE",…}
```

## Opções para o dono decidir

1. **Aceitar o parcelamento sem juros** (Checkout do Asaas, Pix ou cartão em até 12x de R$ 13,25). É o mais simples e cumpre tudo, exceto quem paga os juros. A Letz recebe R$ 152,28 no 12x (em vez de R$ 159,00) e R$ 157,01 no Pix. A landing passa a dizer "12x de R$ 13,25".
2. **Repassar só a taxa do Asaas no preço do cartão**: escolher as parcelas no **nosso** app e criar um Checkout só de cartão com o valor acrescido e `maxInstallmentCount = N`, mais outro Checkout de Pix e cartão 1x a R$ 159. Exemplo: total para a Letz receber R$ 159 líquidos = (159 + 0,49) / (1 − taxa), ou seja, 12x de R$ 13,84 (R$ 166,12), 6x de R$ 27,54 (R$ 165,26). Defeitos: a página do Asaas ainda mostra de 1x a N vezes com o **mesmo total**, então o aluno pode pagar o valor acrescido em menos parcelas, e o aluno escolhe as parcelas duas vezes. Os números da tabela vêm de nós, não do Asaas.
3. **Formulário de cartão próprio** (como os plugins WooCommerce e Nuvemshop): o app coleta os dados do cartão, o servidor calcula a tabela com juros e cria a cobrança por `POST /payments` com `installmentCount`, `totalValue` e `creditCard`/`creditCardToken`. Permite qualquer juro (como os R$ 16,44). Muda o produto: o cartão sai da página do Asaas, os dados do cartão passam pelo nosso código (escopo PCI maior) e exige `remoteIp`. O Pix pode continuar no Checkout.
4. **Preço único maior** para todas as formas: muda a oferta de R$ 159 à vista.

Pedidos ao dono, qualquer que seja a opção:
- Chave Pix cadastrada na conta de produção.
- Se for usar link de pagamento ou cobrança com `callback`, o domínio do site em Minha Conta > Informações (`letz-0-aos-5km.web.app`). O Checkout não exige.
- A conta sandbox é compartilhada: existe outro webhook cadastrado (`auscult-local-felipe`). Ele recebeu (ou tentou receber) os eventos destes testes.

## Rastro deixado no sandbox

- Chave Pix EVP criada (necessária para Pix).
- Clientes de teste "TESTE Letz Sandbox" (CPF 529.982.247-25) `cus_000009700254`, `cus_000009700317` e `cus_000009700335`.
- Link de pagamento `lqo0b35d7o1v5mxw` e cobrança `pay_80g77ovukw21i6lf` (ambos pendentes, de teste).
- Checkout `121ab2db-…` (pago com cartão em 12x e estornado) e `97d20bc1-…` (pago com Pix, estorno aguardando autorização).
- Webhook temporário criado e removido.
