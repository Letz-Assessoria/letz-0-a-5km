# Lançamento em produção

Checklist ordenado do projeto de produção `letz-0-aos-5km` (dev: `letz-0-aos-5km-dev`). Execute na ordem e confira o item "Verificar" de cada passo. Nenhum segredo vai neste arquivo: valores sensíveis entram por stdin ou variável de ambiente, nunca em comando salvo no histórico do repositório.

```bash
export PROJECT=letz-0-aos-5km
export REGION=southamerica-east1
export PROJECT_NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
gcloud config set project $PROJECT
firebase use prod
```

## 1. Faturamento e APIs

1. Plano Blaze ativo no projeto (console Firebase, Uso e faturamento). Verificar: `gcloud billing projects describe $PROJECT` mostra `billingEnabled: true`.
2. Ativar as APIs:

```bash
gcloud services enable firestore.googleapis.com cloudfunctions.googleapis.com cloudbuild.googleapis.com \
  run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com eventarc.googleapis.com \
  firebasestorage.googleapis.com firebasehosting.googleapis.com identitytoolkit.googleapis.com
```

Verificar: `gcloud services list --enabled | grep -c -E 'firestore|cloudfunctions|cloudbuild|run\.|artifactregistry|secretmanager|eventarc|firebasestorage|firebasehosting|identitytoolkit'` devolve 10 ou mais.

## 2. Bancos e Storage

```bash
# Firestore (default) em São Paulo
gcloud firestore databases create --database='(default)' --location=$REGION --type=firestore-native

# Bucket padrão do Storage
TOKEN=$(gcloud auth print-access-token)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT" \
  "https://firebasestorage.googleapis.com/v1alpha/projects/$PROJECT/defaultBucket" \
  -H 'Content-Type: application/json' -d "{\"location\":\"$REGION\"}"
```

Verificar: `gcloud firestore databases list` mostra `(default)` e `gcloud storage buckets list --project=$PROJECT` mostra `letz-0-aos-5km.firebasestorage.app`.

## 3. Firebase Auth

```bash
# Inicializa o Identity Platform
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT" \
  "https://identitytoolkit.googleapis.com/v2/projects/$PROJECT/identityPlatform:initializeAuth" \
  -H 'Content-Type: application/json' -d '{}'

# E-mail/senha ligado e proteção contra enumeração de e-mails
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT" \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT/config?updateMask=signIn.email,emailPrivacyConfig" \
  -H 'Content-Type: application/json' \
  -d '{"signIn":{"email":{"enabled":true,"passwordRequired":true}},"emailPrivacyConfig":{"enableImprovedEmailPrivacy":true}}'
```

Verificar: `curl -s -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT" https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT/config` mostra `signIn.email.enabled: true` e `enableImprovedEmailPrivacy: true`. Nenhum outro provedor (Google etc.) fica ligado.

## 4. Regras e índices

As regras de produção (`firestore.rules`) **não** aceitam o host do emulador do Storage em `imgUrlOk`; só os testes locais usam uma cópia gerada (`scripts/make-test-rules.mjs`, ignorada pelo git). Confira antes do deploy: `grep -c 9199 firestore.rules` deve devolver 0.

```bash
firebase deploy --only firestore:rules,firestore:indexes,storage --project $PROJECT
```

Verificar: console, Firestore, Regras, e os dois índices compostos com status "Ativado" (a criação leva alguns minutos).

## 5. Permissão do Storage para ler o Firestore

As regras do Storage consultam o Firestore (`firestore.get`). Sem esta permissão, ler/gravar foto de perfil e de treino devolve 403:

```bash
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:service-$PROJECT_NUMBER@gcp-sa-firebasestorage.iam.gserviceaccount.com" \
  --role="roles/firebaserules.firestoreServiceAgent"
```

Verificar: `gcloud projects get-iam-policy $PROJECT --flatten=bindings --filter="bindings.role:roles/firebaserules.firestoreServiceAgent" --format="value(bindings.members)"` lista a conta `gcp-sa-firebasestorage`. Se a conta de serviço ainda não existir, envie qualquer arquivo ao Storage pelo console uma vez e repita.

## 6. Segredos das Functions (por stdin)

`ASAAS_API_KEY` é a chave de **produção** do Asaas. `ASAAS_WEBHOOK_TOKEN` tem 32 caracteres ou mais, aleatórios, sem sequência de dígitos. Guarde o token num cofre de senhas: ele é usado de novo no passo 11.

```bash
printf '%s' "$(openssl rand -base64 36 | tr -d '/+=\n' | cut -c1-40)" | firebase functions:secrets:set ASAAS_WEBHOOK_TOKEN --data-file=- --project $PROJECT
# cole a chave de produção quando o comando esperar entrada; não ponha a chave na linha de comando
firebase functions:secrets:set ASAAS_API_KEY --project $PROJECT
```

Verificar: `firebase functions:secrets:access ASAAS_WEBHOOK_TOKEN --project $PROJECT | wc -c` é 40 ou mais (não cole a saída em lugar nenhum).

## 7. Deploy das Functions

Os parâmetros não secretos estão em `functions/.env.letz-0-aos-5km` (Asaas de produção, `APP_URL`, preço). Confira que `ASAAS_BASE_URL=https://api.asaas.com/v3`.

```bash
firebase deploy --only functions --project $PROJECT --force
```

- `--force` aceita a política de limpeza de imagens do Artifact Registry sem perguntar.
- No primeiro deploy de 2ª geração, o Eventarc pode demorar a propagar e as Functions de gatilho (`onPostWritten`, `onReactionWritten`, `onUserWritten`, `onConfigWritten`) falham com erro de permissão. Espere alguns minutos e rode o mesmo comando de novo; é seguro repetir.

Verificar: `firebase functions:list --project $PROJECT` mostra `signup`, `resumeCheckout`, `asaasWebhook` e as quatro de gatilho, todas em `southamerica-east1`.

## 8. Chamada pública (Cloud Run invoker)

As três Functions HTTP precisam aceitar chamadas sem login do Google (a segurança está dentro delas: token do webhook, validação dos dados e limite de cadastros no signup). O deploy de dev esqueceu isso em duas.

```bash
for fn in signup resumecheckout asaaswebhook; do
  gcloud run services add-iam-policy-binding $fn --region=$REGION --member=allUsers --role=roles/run.invoker --project=$PROJECT
  gcloud run services get-iam-policy $fn --region=$REGION --project=$PROJECT | grep -A1 'allUsers'
done
```

Verificar: cada um dos três imprime `- allUsers` com `roles/run.invoker`. Sem isso, `signup` falha no site e `asaasWebhook` devolve 403 ao Asaas (pagamentos nunca ativam e a fila é pausada).

## 9. Config da turma e TTL

```bash
# config/app: início (domingo 08/11/2026 18h, Brasília) como Timestamp e vendas abertas
node -e '
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
initializeApp({ projectId: process.env.PROJECT });
getFirestore().doc("config/app").set({ start: Timestamp.fromDate(new Date("2026-11-08T18:00:00-03:00")), salesOpen: true }, { merge: true })
  .then(() => console.log("ok"));
' 
```

(rode da pasta `functions/` para achar o `firebase-admin`, com `gcloud auth application-default login` feito). O link do grupo de WhatsApp e o vídeo ficam em `config/app` e são editados pelo painel do treinador (`grupo`, `av`); o app não traz nenhum link embutido.

Verificar: `weekOpen()` depende deste documento; sem ele ninguém marca treino. Confira no console que `config/app.start` é do tipo timestamp.

```bash
# TTL: apaga rateLimits vencidos
gcloud firestore fields ttls update expiresAt --collection-group=rateLimits --enable-ttl --database='(default)' --project=$PROJECT
```

Verificar: `gcloud firestore fields ttls list --database='(default)'` mostra `rateLimits.expiresAt` ativo.

## 10. Treinadores (claim admin)

Cada treinador cria a conta pelo cadastro normal ou o script cria uma. Credenciais: `gcloud auth application-default login`.

```bash
node scripts/set-admin.mjs --project prod --email <email-do-treinador>
```

O treinador entra com "Esqueci minha senha" se o script criou a conta. Verificar: depois de sair e entrar, o app abre em `#/admin/...`.

## 11. Asaas (conta de produção)

1. **Chave Pix cadastrada** na conta de produção (app/portal do Asaas, Pix, chaves). Sem chave, `POST /checkouts` com Pix devolve 400 e todo cadastro termina em "indisponível". Verificar com um checkout real de teste (passo 13).
2. **Webhook de produção** por API, com `sendType` SEQUENTIALLY, o token do passo 6 e os eventos abaixo. `PAYMENT_REPROVED_BY_RISK_ANALYSIS` e `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED` bloqueiam quem foi ativado pelo checkout e depois reprovado no risco.

```bash
# ASAAS_API_KEY e WEBHOOK_TOKEN vêm do ambiente/cofre, nunca digitados na linha de comando salva
read -rs ASAAS_API_KEY; export ASAAS_API_KEY
read -rs WEBHOOK_TOKEN; export WEBHOOK_TOKEN
curl -s -X POST https://api.asaas.com/v3/webhooks \
  -H "access_token: $ASAAS_API_KEY" -H 'Content-Type: application/json' \
  -d "{
    \"name\": \"Letz producao\",
    \"url\": \"https://$REGION-$PROJECT.cloudfunctions.net/asaasWebhook\",
    \"email\": \"<email-do-dono>\",
    \"enabled\": true,
    \"interrupted\": false,
    \"apiVersion\": 3,
    \"authToken\": \"$WEBHOOK_TOKEN\",
    \"sendType\": \"SEQUENTIALLY\",
    \"events\": [\"CHECKOUT_PAID\",\"PAYMENT_CONFIRMED\",\"PAYMENT_RECEIVED\",\"PAYMENT_REFUNDED\",
                \"PAYMENT_CHARGEBACK_REQUESTED\",\"PAYMENT_CHARGEBACK_DISPUTE\",
                \"PAYMENT_REPROVED_BY_RISK_ANALYSIS\",\"PAYMENT_CREDIT_CARD_CAPTURE_REFUSED\"]
  }"
unset ASAAS_API_KEY WEBHOOK_TOKEN
```

(a URL real é a de `firebase functions:list`; ajuste se for outra.) O e-mail de falha do webhook do Asaas cai no `email` informado. Verificar: `GET /v3/webhooks` lista o webhook com `enabled: true`, `sendType: SEQUENTIALLY` e os 8 eventos; sem `PAYMENT_DELETED`.

## 12. Alertas

Alerta baseado em log no Cloud Logging (Monitoramento, Alertas, "Criar política com base em log"), e-mail do dono:

```
resource.type="cloud_run_revision"
resource.labels.service_name=("signup" OR "resumecheckout" OR "asaaswebhook")
severity>=ERROR
```

Além disso, o painel do treinador mostra "Atenção: N alertas de pagamento" (coleção `alerts`, escrita pelo webhook) quando um pagamento não ativa a conta, dá pagamento duplicado ou conflito de CPF. O treinador marca como resolvido depois de tratar.

## 13. Teste de fumaça (antes de 08/11/2026)

1. `https://letz-0-aos-5km.web.app` abre a página de vendas sem erros no console.
2. Cadastro com e-mail de teste e CPF válido: abre o checkout do Asaas (prova da chave Pix + chave de API de produção). Pague R$ 5 só se criar um checkout de valor de teste pelo painel do Asaas; caso contrário pague o valor real e estorne em seguida.
3. Depois do pagamento: `#/confirmando` vira o app em poucos segundos (prova do webhook + invoker + token). O evento aparece em `asaasEvents`.
4. Marcar um treino na semana liberada (prova do `config/app` e das regras).
5. Trocar foto de perfil e anexar foto no treino (prova da permissão do passo 5).
6. Estornar o pagamento no Asaas: a conta passa a "Bloqueado" e o aluno perde o acesso.
7. Treinador: entrar, abrir Atletas (sem alertas pendentes), abrir Feed e Medalhas.
8. **IP do rate limit** (premissa não verificada): o cadastro usa o último salto de `x-forwarded-for` como IP do cliente. Faça dois cadastros de teste de redes diferentes (Wi-Fi e dados móveis) e confira que aparecem **dois** documentos `rateLimits/signup_<hash>` diferentes, cada um com `count: 1`. Se aparecer um só, o salto está errado: troque para o penúltimo salto ou `rawRequest.ip` em `functions/src/signup.js` (`clientIp`) antes de abrir as vendas. Único limite que bloqueia: 20 tentativas por IP por hora (o app mostra "Muitas tentativas"). Além disso, mais de 300 cadastros concluídos na mesma hora geram um alerta `signup-spike` no painel (só aviso, nunca recusa ninguém).

Apague os dados de teste depois (usuário no Auth, `users/{uid}`, `cpfs/{cpf}`, `handles/{h}`).

## 14. Reversão

- Functions: `firebase functions:delete <nome> --region $REGION` ou redeploy do commit anterior. O webhook com falha (500) faz o Asaas reenviar; um webhook sem invoker (403) pausa a fila, e é preciso reativar em Asaas, Integrações, Webhooks.
- Regras: console, Firestore/Storage, Regras, Histórico, publicar a versão anterior; ou `git checkout <commit> -- firestore.rules storage.rules` e novo deploy.
- Hosting: console, Hosting, Histórico de versões, reverter.
- Vendas: desmarque "Vendas abertas" no painel (aba Turma) para parar novos cadastros sem mexer em código.

## 15. Notas para o treinador

- Estorno vencido a favor da Letz (chargeback revertido) e estorno de uma só parcela do cartão não são tratados sozinhos: use "Liberar acesso" no painel, depois de conferir no Asaas.
- Se aparecer "Pagamento duplicado" ou "CPF em conflito" na linha de um aluno, o aluno pagou duas vezes ou pagou depois de o CPF ter sido liberado para outro cadastro: resolva no Asaas (estorno) e marque o alerta como resolvido.
- O link do convite do grupo de WhatsApp que existia no código antigo continua no histórico do git: **revogue esse link no WhatsApp** (Info. do grupo, Link de convite, Redefinir link) e cadastre o novo só pelo painel.

## Depois do lançamento

- **Firebase App Check** (reCAPTCHA Enterprise ou v3) com enforcement nas callables `signup` e `resumeCheckout`. É a defesa certa contra cadastro automatizado vindo de muitos IPs.
- Por que não há limite global que bloqueie: um teto global de tentativas deixaria um atacante com muitos IPs travar todos os compradores. Só o limite por IP (20/h) bloqueia; o contador de cadastros concluídos apenas avisa (alerta `signup-spike` no painel, acima de 300/h), nunca recusa ninguém.
