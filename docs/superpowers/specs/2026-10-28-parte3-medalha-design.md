# Parte 3: medalha (compra, envio e controle)

Data: 28/10/2026. Depende das [Parte 1](2026-10-27-parte1-auth-firestore-design.md) e [Parte 2](2026-10-27-parte2-venda-asaas-design.md), já em produção (`letz-0-aos-5km`). O projeto e o fluxo de pagamento do programa não mudam.

## Por que

Quem conclui o "Do 0 aos 5 km" ganha a **medalha Letz bora!**, enviada pelo correio. A medalha em si é do programa; o aluno paga **R$ 35,00 só para custear o frete**. Hoje o app tem um fluxo do protótipo para isso (formulário de endereço, frete por Pix manual com QR, aba "Medalhas" do painel com "Frete por Pix"). Esta parte troca esse fluxo por um **pagamento de verdade pelo Asaas** e por um **controle de envio** feito pelo treinador, com aviso por e-mail ao aluno quando a medalha for enviada.

## Objetivos

- **Aviso e endereço para quem concluiu.** Ao concluir o programa (regra abaixo), o aluno vê um **modal** dizendo que ganhou a medalha, com o formulário de endereço de entrega.
- **Endereço.** Duas opções: **reaproveitar o endereço do cadastro** (já guardado em `users/{uid}/private/profile.address`, da parte 2) ou **informar outro**. O aluno confere o endereço e confirma.
- **Pagamento.** Depois de confirmar, o app abre o **checkout do Asaas** de **R$ 35,00**, **Pix ou cartão, à vista (1x)**. A Letz absorve a taxa do cartão. O cliente abre já preenchido (`customerData`), como no cadastro. Depois de pagar, volta ao app e vê uma tela de sucesso com o **status do envio**.
- **Sem prazo.** A medalha pode ser comprada **a qualquer momento** depois de concluir, mesmo meses depois. O aviso continua aparecendo até a compra.
- **Status do envio, controlados à mão pelo treinador** no painel: `Concluiu, não comprou` (derivado, sem registro), `Pago, aguardando envio`, `Enviado` (com **código de rastreio** e **data de envio**), `Entregue` (com data de entrega).
- **Painel do treinador, aba Medalhas:** visão clara de quem concluiu e não comprou, quem comprou e aguarda envio, quem está a caminho e quem recebeu; contadores por status, filtro por status e busca por nome; em cada pedido, o **endereço completo** (com botão de copiar), data do pagamento, rastreio, data de envio e de entrega; edição do status.
- **E-mail ao aluno** quando o treinador marcar **Enviado**, com rastreio, data de envio e endereço. Todo e-mail transacional sai de `letzassessoria@gmail.com`.
- **Feed:** quem **comprou** a medalha pode postar no feed, como num treino concluído (foto e comentário), com um selo identificando o post como da medalha.
- **Financeiro:** os pagamentos de medalha aparecem junto das vendas, identificados como produto "Medalha Letz bora!", **fora** da receita do programa e do ticket médio dele.

## Não objetivos

- Rastreio automático do envio (Correios), geração de etiqueta, cálculo de frete por CEP, mais de uma medalha por aluno, parcelamento no cartão, estorno automático.
- Mudar o e-mail de redefinição de senha do Firebase (continua saindo do remetente do Firebase; trocar exige domínio próprio).
- Aviso por e-mail de "você ganhou a medalha" ou recibo do pagamento (podem vir depois; a infraestrutura de e-mail fica pronta).

## Antiobjetivos

- Alguém **pagar duas vezes** a medalha, ou o treinador ver um pedido pago como "não comprou".
- Um aluno ver o endereço, o rastreio ou o pagamento de outro.
- O pagamento da medalha **liberar, bloquear ou mudar o acesso** ao programa (ele é independente do acesso).
- A senha do e-mail da Letz aparecer no repositório ou no navegador.
- Receber medalha quem não concluiu o programa (o servidor confere, não só a tela).

## Regra de "concluiu"

**24 treinos feitos e os três últimos dias do programa concluídos** (semana 10: dias 1, 2 e 3, chaves `10-0`, `10-1` e `10-2`). Hoje o código (`core.isConcluded`) exige o último dia e 24 treinos; passa a exigir os **três últimos dias** e 24 treinos. A função está em `public/lib/core.js` (copiada para `functions/shared/core.js`) e vale para o app e para o servidor.

## Pagamento da medalha

- **Preço:** R$ 35,00, fixo, configurável em parâmetro do servidor (`MEDAL_PRICE`, como `PROGRAM_PRICE`). **Pix ou cartão, só 1x.** O Asaas exige cobrança mínima de R$ 5,00 (R$ 35,00 passa).
- O checkout é do mesmo tipo do programa (Asaas Checkout, `externalReference` com o uid, `customerData` do perfil com o **endereço escolhido para a entrega** ou o do cadastro, `successUrl` de volta ao app). O pedido da medalha é **separado** do pagamento do programa: tem o próprio checkout, registro e status.
- **Quem pode comprar:** conta ativa que **concluiu** (conferido no servidor pelos treinos marcados do aluno, `posts`), sem compra de medalha já paga. Uma só medalha por aluno. Se já existe checkout de medalha aberto e válido, reabre em vez de criar outro (mesmo padrão de `resumeCheckout`).
- **Webhook:** o mesmo `asaasWebhook` trata o pagamento da medalha. O checkout de medalha é marcado como tal (`checkouts/{id}` com `kind: 'medal'`) e **não toca em `access`**. Pago confirmado: o pedido da medalha vai para "Pago, aguardando envio" e grava a linha financeira (`payments`, produto "Medalha"). Reembolso total, chargeback ou reprovação: o pedido volta para "Reembolsado" e gera **alerta** no painel (não há acesso a bloquear). Reembolso parcial: alerta, como no programa. Tudo idempotente, como já é.
- Um pagamento de medalha de um aluno que **já pagou** a medalha gera alerta (pagamento duplicado), como no programa.

## Dados

Decisão do autor do design (o construtor pode ajustar os nomes):

- `users/{uid}/private/medal` (só Functions escrevem; o aluno e o treinador leem): `status` (`pending` | `paid` | `shipped` | `delivered` | `refunded`), `address` (cep, rua, número, complemento, bairro, cidade, UF), `checkoutId`, `url`, `expiresAt`, `paidAt`, `trackingCode`, `shippedAt`, `deliveredAt`, `updatedAt`.
- `checkouts/{id}` ganha `kind: 'medal'` (os do programa ficam sem o campo ou com `kind: 'program'`) e o valor.
- O treinador atualiza status, rastreio e datas pelo painel: ou direto no Firestore com regras restritas, ou por callable de admin (decisão do construtor, mas **o e-mail só sai pelo servidor**, no momento em que o status passa a `shipped`).
- Para o treinador listar todos que concluíram e quem comprou sem 1 leitura por aluno, o construtor decide o resumo (por exemplo um campo em `users/{uid}`); a escala é de uma turma, então não é crítico.
- Alertas continuam em `alerts/{id}` (tipos novos de medalha).

## Aluno

- **Modal** ao abrir o app depois de concluir e **sem compra paga**: "Você ganhou a medalha", com **Continuar** (abre o endereço) e **Depois** (fecha; o aviso volta em outra abertura e fica sempre acessível na tela de fim e no menu). Só aparece para quem concluiu pela regra acima.
- **Endereço:** primeira opção é **usar o endereço do cadastro** (mostrado em uma linha para conferir); a outra é **informar outro**, com o mesmo formulário do cadastro (CEP com busca no ViaCEP, número, complemento, rua, bairro, cidade e UF). Quem se cadastrou antes de existir endereço no cadastro (conta antiga) cai direto na opção de informar.
- **Confirmar** → pagamento no Asaas → volta ao app em uma tela **"Pagamento da medalha"** (aguardando a confirmação, como `#/confirmando`) que vira a tela de status quando o webhook chega.
- **Tela da medalha:** status atual com datas, rastreio (texto copiável; link para o rastreamento dos Correios é opcional), endereço de entrega e o botão para postar no feed quando comprou.
- **Feed:** o post da medalha usa o mesmo formulário do post de treino (foto e comentário), com selo "Medalha". Não conta pontos. O treinador pode esconder, como em qualquer post.
- Substitui o fluxo antigo do protótipo (`S.ship`, `pay-open`, Pix manual com QR, campos de frete e chave Pix do painel).

## E-mail

- **Remetente:** `letzassessoria@gmail.com`, via SMTP do Gmail com **senha de app** guardada como **secret** do Firebase (Secret Manager), lida só pela Function. **A senha ainda não foi gerada:** o dono da conta vai gerá-la (precisa de verificação em duas etapas) e repassar depois. Até lá, o código e os testes usam um transporte falso; o envio real só liga quando o secret existir.
- **Quando:** ao marcar `Enviado` (rastreio e data preenchidos). Um e-mail por mudança para `Enviado`; reenviar ao treinador editar rastreio é decisão do construtor (sugestão: botão "Reenviar e-mail", sem reenvio automático).
- **Conteúdo:** em português, curto, com o nome do aluno, o código de rastreio, a data de envio e o endereço de entrega. Sem dados de pagamento.
- Falha de e-mail **nunca** desfaz a mudança de status; vira log (e alerta no painel se der). O limite do Gmail (centenas por dia) basta para a turma.

## Painel do treinador

- Aba **Medalhas** (substitui o conteúdo atual "Frete por Pix"): contadores (Concluiu e não comprou · Pago, aguardando envio · Enviado · Entregue), filtro e busca; a lista mostra, por aluno que concluiu, nome, status, data do pagamento, rastreio, datas e o endereço completo (copiar); ações para marcar **Enviado** (rastreio + data) e **Entregue** (data).
- No **Financeiro**, vendas de medalha com produto "Medalha" e sem entrar na receita do programa.
- Em **Atletas**, o status da medalha do aluno (pequeno), se for simples.
- A aba "Medalhas" já existe nas rotas do painel (`#/admin/medalhas`).

## Decisões do autor depois da revisão do construtor

Marcadas como **minhas**, para o dono conferir:

- **Reembolso, chargeback ou reprovação (minha):** há **um só** documento `private/medal` por aluno. Se o pedido ainda **não foi enviado** (`pending` ou `paid`), vira `refunded` e o aluno pode **comprar de novo** (novo checkout). Se já está `shipped` ou `delivered`, o status e os dados de envio **não são sobrescritos**: só gera alerta no painel para o treinador decidir. O pagamento duplicado de quem já pagou também gera só alerta.
- **Prova de conclusão (minha):** o servidor confere os treinos marcados do aluno **no momento da compra**, contando os posts de treino dele mesmo escondidos pelo treinador (o escondido não "desconclui"). Depois de `paid`, a conclusão **não é rechecada**. Cada treino é uma chave única (`semana-dia`, as três finais são `10-0`, `10-1` e `10-2`).
- **Regra antiga de conclusão (minha):** a turma abre em 08/11/2026 e **não há aluno real** em produção que tenha concluído; não precisa de migração. A nova regra vale para todos.
- **Fluxo antigo do protótipo (minha):** não há dados reais de frete por Pix em produção (nenhum aluno chegou ao fim). O fluxo antigo (`S.ship`, Pix manual com QR, `frete`/`chave`/`pnome`/`pcidade` na configuração) **é removido**, sem migração. Os campos de frete e Pix do painel saem.
- **Transições do treinador (minha, seguindo a sugestão da revisão):** `paid` → `shipped` → `delivered`, só para frente. Pode **corrigir um passo para trás** (`delivered` → `shipped`, `shipped` → `paid`) sem reenviar e-mail; não pode marcar `Enviado` ou `Entregue` um pedido `pending` ou `refunded`. Pode editar rastreio e datas depois de enviado e usar **"Reenviar e-mail"**. O e-mail automático sai **uma vez**, na primeira passagem para `shipped`.
- **Feed (minha, coerente com "quem comprou"):** **um** post de medalha por aluno, liberado quando o pedido está `paid`, `shipped` ou `delivered`; `refunded` perde o direito de postar (o post existente fica e o treinador decide esconder). As regras de `posts` precisam de um caso para o post de medalha, distinto dos de treino (id próprio, sem pontos).

## Restrições

- App em um único `public/index.html`; Functions em `functions/` (Node 22, `southamerica-east1`); regras do Firestore em `firestore.rules`. Teste com emuladores e Asaas falso (`tests/fake-asaas.mjs`); e2e com Playwright.
- Todo texto de usuário passa por `esc()`; nenhum CPF na tela; o endereço só com o aluno e o treinador.
- Produção: `letz-0-aos-5km`. As Functions novas precisam de chamada pública (`allUsers` com `run.invoker`) como as demais, com a checagem de login e admin dentro do código.
- Landing e FAQ citam a medalha ("frete à parte", "Como recebo a medalha?"): o texto passa a dizer **R$ 35,00 de frete, pagos no fim, Pix ou cartão à vista**.

## O que fica a critério de quem constrói

Os nomes dos campos e documentos; o resumo para o painel listar todos os concluídos; se as atualizações do treinador são por callable ou por regras; o texto exato do e-mail e do modal; a política de reenvio de e-mail; o visual do selo no feed (seguindo a linguagem visual já usada).

## Passos do dono (fora do repositório)

- Gerar a **senha de app** da conta `letzassessoria@gmail.com` e repassar para quem constrói (entra como secret, nunca no repositório).
- Confirmar o texto final do FAQ e da landing sobre a medalha.
- Pessoa do time que vai marcar os envios no painel e usar o código de rastreio dos Correios.
