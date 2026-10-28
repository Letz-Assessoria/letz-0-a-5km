// Cria functions/.secret.local (ignorado pelo git) com secrets FALSOS para os emuladores,
// se ainda não existir. Nunca coloque chave real do Asaas aqui.
import { existsSync, writeFileSync } from 'node:fs';

const file = new URL('../functions/.secret.local', import.meta.url);
if (!existsSync(file)) {
  writeFileSync(file, 'ASAAS_API_KEY=chave-falsa-do-emulador\nASAAS_WEBHOOK_TOKEN=token-falso-do-emulador\nGMAIL_APP_PASSWORD=senha-falsa-do-emulador\n');
  console.log('functions/.secret.local criado com valores falsos');
}
