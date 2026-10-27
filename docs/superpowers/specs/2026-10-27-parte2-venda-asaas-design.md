# Parte 2: venda do programa pelo Asaas

Data: 27/10/2026. Depende de: [Parte 1](2026-10-27-parte1-auth-firestore-design.md). Projeto Firebase: `letz-0-aos-5km`.

## Por que

A Letz decidiu usar **só o Asaas** para receber, sem Kiwify. A venda tem que funcionar sozinha: a pessoa se cadastra na landing, paga no Asaas e volta para o app já logada e com acesso, sem ninguém da Letz liberar à mão. **As partes 1 e 2 vão juntas para produção**, antes da abertura da turma em 8/11/2026 às 18h.

## Objetivos

- **Cadastro** (`#/cadastro`, aberto pelos "Quero participar" da landing) com nome, e-mail, **CPF** (com validação dos dígitos), **celular**, senha, confirmação de senha e aceite da política de privacidade.
- O cadastro cria a conta no Firebase Auth com acesso **pendente** (modelo da parte 1) e faz login.
- O servidor cria o cliente e a cobrança no Asaas e manda a pessoa para a **página de pagamento do Asaas**.
- **Preço:** R$ 159,00 à vista no **Pix** ou no **cartão**, ou em **até 12x no cartão com os juros pagos pelo aluno**.
- O Asaas avisa o servidor (webhook) e o servidor marca a conta como **ativa**. Esse é o único caminho automático para liberar acesso. A liberação manual pelo painel continua existindo para exceções.
- **Volta para o app:** depois do pagamento, o Asaas devolve a pessoa ao app (URL de retorno). Ela já está logada desde o cadastro. Se a confirmação ainda não chegou, aparece "Confirmando seu pagamento…", e a tela muda sozinha (listener no documento do usuário) quando a conta ficar ativa.
- **Pagamento abandonado:** quem está pendente e entra depois vê "Concluir pagamento". O botão reabre a cobrança existente, se ainda for válida, ou cria outra. Não precisa se cadastrar de novo nem gerar cobrança duplicada para quem já pagou.
- **Reembolso ou estorno:** o aviso do Asaas **bloqueia** a conta automaticamente, com o comportamento de aluno bloqueado da parte 1.
- **Painel, aba Atletas:** mostra o status de pagamento (pendente, pago, reembolsado ou estornado), a forma de pagamento e a data, além do status de acesso. O e-mail, o CPF e o celular aparecem só para o treinador.

## Não objetivos

- A medalha (parte 3).
- Cupons, descontos, assinatura recorrente, mais de um produto.
- Troca de textos que citam Kiwify (parte 4). As telas `#/comprar` e `#/compra-aprovada`, de simulação, **saem nesta parte**, porque o fluxo passa a ser cadastro → Asaas → app.
- Emissão de nota fiscal pelo nosso código. Se a Letz quiser, configura a emissão automática na própria conta do Asaas.

## Antiobjetivos

- Alguém ganhar acesso sem pagar, por exemplo chamando o webhook diretamente, mexendo no próprio documento ou voltando pela URL de retorno sem ter pago.
- Cobrar duas vezes a mesma pessoa, ou gerar uma conta de acesso duplicada para o mesmo pagamento.
- A chave da API do Asaas aparecer no navegador ou no repositório, que é **público**.
- O aluno pagar e ficar sem acesso por falha nossa sem que ninguém perceba.
- Um aluno ver CPF, celular ou dados de pagamento de outro.

## Restrições

- **Segredos** (chave da API do Asaas, token do webhook) ficam em **Firebase secrets** (Secret Manager) e são lidos só pelas Cloud Functions.
- **Ambientes:** sandbox do Asaas para desenvolvimento e para o canal de pré-visualização. Produção do Asaas só no site de produção. A troca entre os dois é por configuração, sem mudar código.
- **Webhook autenticado** pelo token de acesso que o Asaas envia no cabeçalho (`asaas-access-token`), comparado com o secret. Ele deve ser **idempotente**, porque o Asaas pode reenviar o mesmo evento. Eventos desconhecidos são ignorados com resposta 200, para a fila do Asaas não travar.
- CPF e celular ficam em `users/{uid}/private/*`. Só o dono e o treinador leem. O `access` e os campos de pagamento **só são escritos pelo servidor** (Functions) ou pelo treinador.
- Região das Functions: `southamerica-east1`. Plano Blaze (o dono habilita).
- O app continua em um único `public/index.html`. As Functions ficam em `functions/` (Node, mesmo repositório).

## Decisões do dono

- Asaas para tudo. O CPF e o celular são pedidos no **nosso** cadastro.
- R$ 159,00 à vista, ou até 12x com os juros pagos pelo aluno.
- A conta da Letz no Asaas já existe e há acesso ao sandbox.
- Partes 1 e 2 sobem juntas.
- **Sem limite de vagas.**
- **Dois projetos Firebase:** `letz-0-aos-5km` (produção, Asaas de produção) e `letz-0-aos-5km-dev` (testes, Asaas sandbox), cada um com Blaze e secrets próprios. Use aliases no `.firebaserc` (`prod` e `dev`). O canal de pré-visualização e os testes ponta a ponta rodam no projeto dev. O projeto de produção **nunca** fala com o sandbox, e o dev nunca fala com a produção do Asaas.
- **Endereço de produção:** `https://letz-0-aos-5km.web.app`, sem domínio próprio por enquanto. É esse endereço que vai para a URL de retorno do Asaas.

## Decisões do autor do design (o dono pode revisar)

- Quem fecha a página sem pagar retoma pelo "Concluir pagamento" ao entrar.
- Reembolso ou estorno bloqueiam a conta automaticamente.
- Conferência de falhas: o painel destaca contas pendentes há mais de 24 h e pagamentos recebidos que não liberaram acesso, se houver. Os erros das Functions vão para o Cloud Logging.

- **Construção:** as partes 1 e 2 entram no mesmo plano de construção, feito pela mesma pessoa. A parte 1 vem primeiro. O modelo de dados (`users/{uid}/private/*`, `access`, status de pagamento, cópia do status de bloqueado) é desenhado uma vez só, servindo às duas.
- **Textos mínimos da parte 4 sobem no lançamento:** nada de "Kiwify" visível, e a política de privacidade atualizada para Asaas, com CPF e celular. A política é aceita no cadastro e precisa estar correta no dia 1, por causa da LGPD. O restante da parte 4 pode vir depois.
- **As vendas ficam abertas, sem data de encerramento**, inclusive depois que a turma abre. Quem entra depois segue o que o FAQ já promete: começa pela semana 1, e os treinos pontuam a partir do dia em que entrou. Se a Letz quiser fechar as vendas, o painel tem um interruptor "Vendas abertas", conferido também no servidor.
- **Um CPF, uma conta.** O CPF é do aluno e fica reservado de forma única (`cpfs/{cpf}` → uid, como `handles/`). Quem tentar outro cadastro com o mesmo CPF recebe a orientação de entrar na conta existente. No Asaas, o cliente é criado com esse CPF. Compra feita por outra pessoa para o aluno não é suportada nesta versão.

## A conferir durante a construção

- **Forma de pagamento no Asaas** com Pix e cartão, parcelamento em até 12x com juros pagos pelo aluno e URL de retorno. Comparar a cobrança com `invoiceUrl`, os links de pagamento e o Checkout do Asaas, e escolher a que cumpre os quatro requisitos. Se o Asaas não fizer o repasse de juros sozinho, calcular o valor das parcelas no servidor com a taxa da conta.
- **O valor real das parcelas.** A landing diz "12x de R$ 16,44". O número exibido tem que ser o que o Asaas cobra de verdade. Se mudar, a landing passa a mostrar o valor real.
- **Quais eventos do webhook** significam pago (Pix e cartão), reembolsado e estornado.

## O que fica a critério de quem constrói

- A estrutura dos documentos de pagamento (por exemplo, `payments/{asaasPaymentId}`), desde que permita conferir idempotência e o histórico.
- As mensagens de erro do cadastro: CPF inválido, e-mail já cadastrado, falha ao criar cobrança.
- Como testar ponta a ponta no sandbox (emuladores mais um túnel, ou o canal de pré-visualização com Functions de verdade).

## Passos do dono (fora do repositório)

- Habilitar o plano Blaze nos dois projetos (`letz-0-aos-5km` e `letz-0-aos-5km-dev`).
- Gerar as chaves da API do Asaas (sandbox e produção) e informá-las como secrets quando quem constrói pedir, sem colar em arquivo do repositório.
- Cadastrar a URL do webhook no painel do Asaas, que quem constrói informa.
