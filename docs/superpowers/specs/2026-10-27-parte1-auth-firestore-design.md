# Parte 1: contas reais (Firebase Auth) e dados no Firestore/Storage

Data: 27/10/2026. Projeto Firebase: `letz-0-aos-5km`. Site: https://letz-0-aos-5km.web.app

## Por que

O Do 0 aos 5 km vai para produção com a turma que abre em **8 de novembro de 2026, às 18h**. Hoje o app é um protótipo de um aparelho só: tudo fica no `localStorage`, o feed e o ranking usam alunos fictícios, o login aceita qualquer coisa e o painel abre com um código fixo (`adm123`). Esta parte transforma o app em um produto real e multiusuário. Cada aluno passa a ter conta, os dados ficam salvos no servidor e a turma se vê de verdade no feed e no ranking.

Esta é a parte 1 de 4:
1. **Contas e dados (este documento).**
2. Venda do programa pelo Asaas (cadastro → pagamento → acesso liberado automaticamente).
3. Medalha pelo Asaas (Pix ou cartão, com acréscimo no cartão).
4. Textos: trocar Kiwify por Asaas no site, no FAQ e na política de privacidade.

A parte 1 precisa deixar pronto o "encaixe" da parte 2: contas criadas antes do pagamento e acesso liberado só depois.

**Lançamento:** a parte 1 **não vai para produção sozinha**. Ela sobe junto com a parte 2, já com o Asaas cobrando, antes da abertura da turma em 8/11. Enquanto isso, o desenvolvimento roda nos emuladores e num canal de pré-visualização do Hosting (`firebase hosting:channel:deploy`). O site de produção atual fica como está até o lançamento conjunto. A liberação manual pelo painel continua existindo em produção, como alternativa para casos excepcionais.

## Objetivos

- Login com **e-mail e senha** (Firebase Auth), com "Esqueci minha senha".
- **Cadastro** (nome, e-mail, senha e aceite da política de privacidade) a partir do "Quero participar" da landing. Cria a conta com acesso **pendente**.
- Conta pendente não entra no app. Ela vê uma tela "Aguardando confirmação do pagamento", com o contato da Letz.
- Até a parte 2 existir, o **treinador libera a conta manualmente** pelo painel. Na parte 2 quem libera é o aviso do Asaas.
- Persistir no **Firestore**: perfil (nome, @), treinos marcados, comentários dos treinos, comentários e reações do feed, endereço e status da medalha, e as configurações do painel.
- Persistir no **Cloud Storage**: foto de perfil e fotos de treino.
- Feed e ranking com a **turma real**. Valem as regras de pontos atuais: 3 pontos por treino e no máximo 3 treinos pontuando por semana da turma.
- **Painel do treinador** acessado com a conta do próprio treinador, por permissão, sem código fixo.
- Remover tudo o que é teste: botões "Simular…", "Liberar as 10 semanas (teste)", "Voltar para a semana 1", "Simular projeto encerrado", "Simular 24 treinos", "Simular pagamento confirmado", alunos e comentários de exemplo (`SAMPLE`, `SEEDC`, reações-base fictícias), avisos "Versão de teste" e o código `adm123`.

## Não objetivos

- Pagamentos de qualquer tipo, que ficam nas partes 2 e 3. O fluxo de frete por Pix "copia e cola" que já existe **continua como está**. A diferença é que o pagamento passa a ser confirmado manualmente pelo treinador no painel, em vez do botão de simulação.
- Mais de uma turma. Existe **uma turma só**, e o produto sem turma fica para depois da validação.
- App nativo e notificações push.
- Troca dos textos que citam Kiwify (parte 4).

## Antiobjetivos (falha mesmo que "funcione")

- Um aluno conseguir ver o e-mail, o endereço ou o celular de outro aluno.
- Um aluno conseguir inflar os próprios pontos, por exemplo escrevendo pontos direto ou marcando treino com data retroativa.
- Alguém entrar no painel só por saber um e-mail ou por criar uma conta com o e-mail de um treinador.
- Perder dados de alunos no meio da turma.
- O treinador precisar de terminal para a rotina do dia a dia (liberar aluno, moderar, editar textos, marcar frete pago, cadastrar rastreio).

## Restrições

- O app continua sendo **um único `public/index.html`** em JavaScript puro, com o estilo de código atual: strings de template, `render()`, `data-act`. Não adotar framework nem build step. O Firebase entra pelo SDK Web modular, carregado do CDN oficial (`gstatic`) com versão fixa.
- A navegação por hash já existe (`#/entrar`, `#/app/feed`, `#/admin/...`) e deve continuar funcionando. Hoje o "papel" do usuário vive no `sessionStorage` (`role`). Ele passa a vir da sessão do Firebase Auth, que persiste entre aberturas do app.
- Plano **Blaze**, que o dono vai habilitar. Região do Firestore e do Storage: `southamerica-east1` (São Paulo).
- O **repositório é público** (`Letz-Assessoria/letz-0-a-5km`). Nada de segredo, e-mail pessoal dos treinadores ou chave privada vai para o repositório. A configuração Web do Firebase (apiKey etc.) é pública por natureza e pode ficar no HTML.
- Turma pequena: dezenas, no máximo poucas centenas de alunos. Sem otimização prematura, mas sem ler o banco inteiro a cada tela.

## Decisões já tomadas (pelo dono)

- E-mail e senha, conta criada no cadastro, antes do pagamento.
- Fotos no Storage, todo o resto no Firestore.
- Uma turma só. A data de abertura **já vem com o padrão 8/11/2026 18h** e pode ser alterada no painel.
- Treinadores: o dono do projeto e o Erik agora, e o Uriel depois. Os e-mails ficam **fora do repositório**: o dono passa os e-mails para quem for executar a configuração.
- A tela de instalação deve **explicar** que, no iPhone, o app instalado na tela inicial pede login de novo (não compartilha a sessão do Safari).

## Desenho

### Contas e permissões

- **Aluno:** documento `users/{uid}` com `name`, `handle`, `photoURL`, `createdAt`, `profiled`, `welcomed` e `access` (`pending` | `active` | `blocked`). O aluno edita o próprio perfil, mas **nunca** o campo `access`, que só o treinador (e, na parte 2, o servidor) altera.
- **Dados privados do aluno** (e-mail, endereço de entrega, celular) ficam em `users/{uid}/private/*`. Só o dono e o treinador leem.
- **Treinador:** identificado por **custom claim** `admin: true` no Firebase Auth, definida por um script de uso único (`scripts/set-admin.mjs`, com `firebase-admin` e as credenciais locais do dono) que recebe o e-mail pelo terminal. Usar claim, e não lista de e-mails nas regras, impede que alguém crie uma conta com o e-mail de um treinador e ganhe acesso. Depois de criada a claim, o treinador faz login normalmente e vê o painel.
- **Handle (@) único**, garantido com uma coleção de reserva (`handles/{handle}` → `uid`) gravada na mesma transação do perfil.

### Treinos, feed e ranking

- Cada treino marcado é um **post**: `posts/{uid}_{semana}-{dia}` com `uid`, `handle`, `name`, `photoURL` do autor (cópia para exibir no feed), `w`, `d`, `at` (horário do servidor, obrigatório pelas regras), `comment` e `photoPath` opcionais e `removed` (moderação).
- Desmarcar o treino apaga o post, os comentários e a foto.
- **Comentários do feed:** `posts/{id}/comments/{cid}`. O autor apaga os próprios comentários e o treinador apaga qualquer um.
- **Reações** (oi, palmas, fogo, força, amor): uma por tipo por aluno, com contagem visível. A estrutura fica a critério de quem constrói, com uma restrição: um aluno não consegue mexer na reação de outro.
- **Pontos e ranking** não podem ser escritos pelo aluno. Recomendação: uma Cloud Function disparada quando um post é criado ou apagado recalcula `points` e `done` no documento público do aluno, com a mesma regra de hoje (`pointedSet`: os 3 primeiros treinos de cada semana da turma, contados pelo horário em que foram marcados). O ranking lê esses campos.
- O feed mostra os posts mais recentes da turma, paginados. O feed atual não tem paginação, então aqui é carregar mais ao rolar.
- **Medalha liberada** continua com a regra de hoje (`concluded`: marcou o último treino e fez pelo menos 24 dos 30), calculada a partir dos posts do próprio aluno.

### Medalha (só persistência nesta parte)

- O endereço de entrega vai para `users/{uid}/private/ship`. Os campos de status são `paidAt` e `track`, e **só o treinador** os altera.
- O pagamento do frete continua pelo Pix "copia e cola" que já existe. O aviso "Versão de teste" e o botão de simulação saem. O treinador confirma o pagamento no painel, aba Medalhas, que passa a listar **todos os alunos** com endereço, e não só "este aparelho".

### Configurações (painel)

- `config/app`: data de abertura da turma (padrão `2026-11-08T18:00:00-03:00`), textos dos 30 treinos editados, vídeos, link do vídeo da assessoria, WhatsApp da assessoria, link do grupo, valor do frete e dados do Pix (chave, nome e cidade do recebedor). Alunos com acesso liberado leem e só o treinador escreve.
- **Aba Atletas:** lista os alunos reais com status de acesso, botão **Liberar acesso / Bloquear**, número de treinos e pontos.
- **Aba Feed:** moderação, apagando posts e comentários.

### Fotos (Storage)

- `avatars/{uid}.jpg` e `workouts/{uid}/{semana}-{dia}.jpg`, com a compressão que o app já faz antes do envio.
- As regras exigem que o dono escreva só no próprio caminho, que o arquivo seja imagem e que tenha no máximo ~2 MB. Só usuários com acesso liberado leem.

### Telas e fluxo

- **Landing → "Quero participar" → cadastro** (nova tela, `#/cadastro`): nome, e-mail, senha, confirmação de senha e aceite da política com link. Ao enviar, cria a conta e vai para "Aguardando confirmação" (`#/aguardando`). Na parte 2 esse passo redireciona para o Asaas.
- **Entrar** (`#/entrar`): e-mail e senha, "Esqueci minha senha" (e-mail de redefinição do Firebase) e link para o cadastro.
- **Conta pendente** que faz login cai em "Aguardando confirmação".
- **Conta ativa** sem perfil vai para Perfil, depois Boas-vindas, depois o app, como hoje.
- **Sair** encerra a sessão do Firebase.
- Mensagens de erro em português para os casos comuns: e-mail já cadastrado, senha fraca, senha errada, sem conexão.
- Os textos de login que falam em "código de acesso recebido no e-mail" mudam para e-mail e senha. O restante dos textos da Kiwify fica para a parte 4.

### Segurança

- Regras do Firestore e do Storage escritas e **testadas no emulador** (Firebase Emulator Suite), cobrindo os antiobjetivos acima.
- O Firebase App Check fica a critério de quem constrói, como recomendado mas opcional.

## Decisões do autor do design (o dono pode revisar)

- **Treino feito ≠ conteúdo publicado.** O treino marcado vale para pontos e medalha. A foto e o comentário são conteúdo. O aluno pode tirar a própria foto ou o próprio comentário sem desmarcar o treino. Quando o treinador modera, só **esconde o conteúdo** (foto e comentário somem do feed): o treino continua contando pontos e o "Restaurar" continua existindo no painel. O modelo de dados deve permitir isso.
- **Aluno bloqueado** (por exemplo, depois de um reembolso) perde o acesso. Ao entrar, ele vê uma mensagem própria, diferente de "Aguardando", com o contato da Letz. Os posts, comentários, reações e a posição dele no ranking **somem para a turma**. Isso implica copiar o status do autor para o que a turma lê, ou outra forma equivalente que funcione com as regras do Firestore.
- **Treinadores não participam como alunos.** Não aparecem no feed nem no ranking e não passam pelo fluxo de perfil e boas-vindas. "Ver como atleta" é só uma pré-visualização.
- **O contato da Letz** (e-mail e WhatsApp) mostrado nas telas "Aguardando" e "Bloqueado" fica fixo no HTML, porque quem está pendente não lê `config/app`.
- **As regras impedem marcar treino de semana ainda trancada.** Se a data de abertura mudar, os pontos são recalculados.

## O que fica a critério de quem constrói

- Estrutura exata das reações e da paginação do feed.
- Se a contagem de pontos usa Cloud Function (recomendado) ou outra forma que respeite o antiobjetivo.
- Como organizar o carregamento do SDK e os listeners em tempo real dentro do `index.html`.
- Estados de carregamento e mensagens de vazio.

## Fora do repositório (passos do dono)

- Habilitar o plano Blaze no projeto `letz-0-aos-5km`.
- Fornecer os e-mails dos treinadores na hora de rodar o script de permissão. O do Uriel virá depois.
