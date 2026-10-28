# Melhorias e pendências pós-lançamento

Lista do que ficou de fora de propósito nas Partes 1 e 2 (produção publicada em 28/10/2026, turma abre em 08/11/2026 às 18h). Nada aqui bloqueia a primeira turma. A ordem é de prioridade dentro de cada grupo. Marque `[x]` ao concluir e anote o PR.

Fontes: revisão final do PR #2, revisão da Task 12, revisões de segurança automáticas e a lista de menores adiados do ledger de construção.

## 1. Antes ou logo depois da abertura da turma

- [ ] **Teste de fumaça com pagamento real.** Cadastro com CPF válido, pagamento (Pix ou cartão), `#/confirmando` virar o app, evento em `asaasEvents` e linha em `payments`, estorno no Asaas e conta "Bloqueado". Passos em `docs/lancamento.md`, seção 13.
- [ ] **Confirmar o IP do cliente (XFF) nos logs** depois do primeiro cadastro: o limite de cadastro por IP usa o último salto de `X-Forwarded-For` (`functions/src/signup.js`). Se o IP gravado for o do proxy, o limite trata todos como um só.
- [ ] **Link do grupo de WhatsApp.** Revogar o convite antigo (continua no histórico do git) e colocar o novo no painel, em Conteúdo.
- [ ] **Chave do Asaas sandbox** colada no chat durante os testes: revogar.
- [ ] **Conferir o primeiro webhook de produção** no painel do Asaas (sem erro, fila não pausada) e o alerta por e-mail (`erikfpersonal379@gmail.com`).
- [ ] **Texto da política de privacidade:** explicar em uma linha por que o CPF é coletado (identificar o comprador e evitar compra duplicada) e conferir a data da política (M11 da revisão final; pode já ter sido ajustado, confirmar).
- [ ] **Revincular o projeto de dev ao faturamento** quando a cota de projetos da conta aumentar, ou mover o faturamento de produção para uma conta da Letz. Hoje as Functions do dev estão paradas.

## 2. Segurança e robustez (próximo PR de endurecimento)

- [ ] **Moderação no servidor.** Posts e comentários com `hidden:true` ainda são legíveis por qualquer aluno ativo via SDK; o esconder é só no cliente. Regra de leitura `isAdmin() || isActive() && (hidden == false || uid == auth.uid)`, filtro `hidden == false` na consulta do feed e bloquear o delete do autor enquanto `hidden == true` (M4).
- [ ] **Reserva de `@`.** O formato já é validado. Falta exigir conta ativa para criar `handles/*`, para um cadastro sem pagamento não reservar vários `@` (M14).
- [ ] **App Check ou captcha** no cadastro: o limite de IP não deve ser a única barreira (`signup`).
- [ ] **URL de imagem por dono.** `imgUrlOk` já aceita só os buckets do projeto. Dá para restringir também ao caminho do próprio usuário (`avatars/<uid>`, `workouts/<uid>/…`), hoje um aluno consegue apontar para a foto de outro do mesmo bucket.
- [ ] **Checkout duplicado.** Pago no checkout A enquanto `billing.checkoutId` é B: cancelar B depois da transação (`cancelCheckoutQuietly`) (M2).
- [ ] **"Ainda não paguei" em `#/confirmando`.** Não substituir um checkout com menos de 60 minutos; janela pequena de pagamento duplicado nos 5 últimos minutos (M3). O flag `duplicate` já cobre.
- [ ] **Falha isolada de `payments`.** Hoje um erro ao montar a linha só vai para o log. Se quiser mais garantia, escrever fora da transação e testar uma falha forçada.
- [ ] **Estorno parcial e chargeback ganho** não são tratados sozinhos (M16). O treinador usa "Liberar acesso". Documentar para o treinador.

## 3. Painel do treinador

- [ ] **Escala de `listAthletes`:** 3 leituras por aluno (profile, billing, ship) a cada mudança. Para turmas grandes, guardar o resumo no próprio `users/{uid}` ou paginar.
- [ ] **Financeiro de pagamentos antigos:** pagamentos anteriores à Task 12 não têm linha em `payments`; só aparecem com novos eventos. Rodar um preenchimento, se existir algum.
- [ ] **Líquido do estorno:** o Asaas não manda `netValue` no estorno, então o líquido mantém a soma anterior.
- [ ] **Ticket médio** arredonda como no protótipo do Erik (309,29 / 2 = 154,64). Trocar por arredondamento correto, se o dono preferir.
- [ ] **Preço no cliente:** pendentes usam `PROGRAM_PRICE = 159` fixo em `index.html`. Se o preço mudar, ler do servidor.
- [ ] **Barra Salvar:** guardar o rascunho contra recarga (aviso `beforeunload`), não perder uma edição feita durante o salvamento e não marcar como "sujo" quando o texto volta ao original.
- [ ] **Liberação manual de semana:** ficou de fora da Task 12 (existia no painel do Erik).
- [ ] **Comentários e contagens de alunos bloqueados** ainda aparecem (M10); filtrar os comentários pelo conjunto de uids do ranking.

## 4. Aluno e feed

- [ ] **Desmarcar treino:** apaga o post, mas comentários e reações de outros ficam na subcoleção e voltam ao marcar de novo (`unmarkWorkout`, `fb.js`).
- [ ] **Erro do `saveProfile`:** qualquer `permission-denied` vira "Esse @ já está em uso". Distinguir a causa.
- [ ] **Feed:** um listener de comentários e uma leitura de reações por post; cada "Ver mais" soma conexões. Agrupar ou carregar sob demanda.
- [ ] **CTA de venda com vendas fechadas:** visitante anônimo só descobre depois de preencher o formulário (M13).

## 5. Próximas partes do produto

- [ ] **Parte 3: pagamento da medalha.** Segundo checkout no fim do programa, mais o envio. Decisões abertas: preço, acréscimo no cartão (o Asaas só repassa taxa em link criado no painel), quando abre e quem paga o frete. Começa com brainstorm e spec.
- [ ] **Parte 4: textos e conteúdo.** Troca dos textos que ainda citam Kiwify e demais ajustes. O mínimo (política com Asaas, CPF e celular) já foi.
- [ ] **Produto sem turma.** Depois de validar a primeira turma, trocar o início fixo da turma por início por aluno.
- [ ] **Domínio próprio.** Hoje `letz-0-aos-5km.web.app`. Se mudar, atualizar `APP_URL`, URL de retorno do Asaas e domínios autorizados do Auth.

## 6. Operação

- [ ] **Rotina de custos:** acompanhar o faturamento do Firebase nas primeiras semanas (Functions, Firestore e Storage).
- [ ] **Backup do Firestore:** agendar backup diário (`firestore_create_backup_schedule`) em produção.
- [ ] **Alerta de erros:** política de alerta por log para `signup`, `resumecheckout` e `asaaswebhook` (`docs/lancamento.md`, seção 12).
- [ ] **Chave Pix e webhook:** conferir periodicamente que o webhook não está pausado ("interrupted") no Asaas.
