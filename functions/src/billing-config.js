// Parâmetros e secrets do Asaas, compartilhados pelo cadastro e pelo webhook.
// Valores não secretos: functions/.env.<projeto> (e .env.local nos emuladores).
// Secrets: Secret Manager (e functions/.secret.local, falso, nos emuladores).
const { defineSecret, defineString } = require('firebase-functions/params');
const { createClient } = require('./asaas.js');

const ASAAS_API_KEY = defineSecret('ASAAS_API_KEY');
const ASAAS_WEBHOOK_TOKEN = defineSecret('ASAAS_WEBHOOK_TOKEN');
// Senha de app do Gmail (e-mail da medalha). Existe no Secret Manager de produção; só as funções
// que enviam e-mail a declaram em `secrets`. Sem o valor, o mailer devolve `not-configured`
// (produção); só no emulador ele usa um transporte falso.
const GMAIL_APP_PASSWORD = defineSecret('GMAIL_APP_PASSWORD');
const ASAAS_BASE_URL = defineString('ASAAS_BASE_URL');
const APP_URL = defineString('APP_URL');
const PROGRAM_PRICE = defineString('PROGRAM_PRICE');
const MEDAL_PRICE = defineString('MEDAL_PRICE');
const MAX_INSTALLMENTS = defineString('MAX_INSTALLMENTS');

const MINUTES_TO_EXPIRE = 60;

function asaasClient() {
  return createClient({ baseUrl: ASAAS_BASE_URL.value(), apiKey: ASAAS_API_KEY.value() });
}

// Dados do cadastro para o checkout do Asaas abrir já preenchido. Sem endereço (conta antiga),
// devolve undefined e o Asaas pede tudo na própria página. `address` (opcional) é o endereço
// de entrega escolhido (medalha); sem ele vale o do cadastro. Perfil ausente também devolve
// undefined (CPF e telefone só existem no perfil): o Asaas pede os dados na própria página.
function customerDataOf(name, profile, address) {
  const a = address || (profile && profile.address);
  if (!a || !profile || !profile.cpf || !profile.email || !profile.phone || !name) return undefined;
  const data = {
    name, cpfCnpj: profile.cpf, email: profile.email, phone: profile.phone,
    address: a.street, addressNumber: a.number, province: a.district, postalCode: a.cep, city: a.city,
  };
  if (a.complement) data.complement = a.complement;
  return data;
}

function checkoutArgs(uid, customerData, value) {
  const app = APP_URL.value().replace(/\/+$/, '');
  return {
    uid,
    value: typeof value === 'number' && value > 0 ? value : Number(PROGRAM_PRICE.value()),
    maxInstallments: Number(MAX_INSTALLMENTS.value()),
    successUrl: `${app}/#/confirmando`,
    cancelUrl: `${app}/#/aguardando`,
    expiredUrl: `${app}/#/aguardando`,
    minutesToExpire: MINUTES_TO_EXPIRE,
    customerData,
  };
}

// Checkout da medalha: valor só de MEDAL_PRICE, 1x (sem parcelas), volta para a tela da medalha.
function medalCheckoutArgs(uid, customerData) {
  const app = APP_URL.value().replace(/\/+$/, '');
  return {
    uid,
    value: Number(MEDAL_PRICE.value()),
    maxInstallments: 1,
    successUrl: `${app}/#/medalha`,
    cancelUrl: `${app}/#/app/fim`,
    expiredUrl: `${app}/#/app/fim`,
    minutesToExpire: MINUTES_TO_EXPIRE,
    customerData,
    itemName: 'Medalha Letz bora!',
    itemDescription: 'Frete da medalha de conclusão',
  };
}

module.exports = {
  ASAAS_API_KEY, ASAAS_WEBHOOK_TOKEN, GMAIL_APP_PASSWORD, PROGRAM_PRICE, MEDAL_PRICE, APP_URL,
  asaasClient, checkoutArgs, medalCheckoutArgs, customerDataOf,
};
