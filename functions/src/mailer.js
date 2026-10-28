// E-mail transacional da Letz, via SMTP do Gmail (senha de app no secret GMAIL_APP_PASSWORD).
// Nunca lança: falha vira log e { sent: false }. Sem o secret (emuladores, antes de a senha
// existir), usa um transporte falso e guarda a última mensagem em memória para os testes.
const nodemailer = require('nodemailer');
const logger = require('firebase-functions/logger');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { GMAIL_APP_PASSWORD } = require('./billing-config.js');
const { safeErr } = require('./safe.js');

const FROM = 'Letz Assessoria <letzassessoria@gmail.com>';
const SMTP_USER = 'letzassessoria@gmail.com';

let lastFake = null;

function appPassword() {
  try {
    return GMAIL_APP_PASSWORD.value() || '';
  } catch {
    return '';
  }
}

// Só no emulador: as Functions rodam em outro processo, então os testes leem a última
// mensagem falsa em testMail/last e podem forçar falha com testFaults/mail { fail: true }.
const inEmulator = () => process.env.FUNCTIONS_EMULATOR === 'true';

async function sendMail({ to, subject, text } = {}) {
  try {
    if (!to || !subject || !text) throw new Error('mailer: to, subject e text obrigatórios');
    if (inEmulator() && (await getFirestore().doc('testFaults/mail').get()).get('fail') === true) throw new Error('mailer: falha injetada');
    const pass = appPassword();
    if (!pass) {
      lastFake = { from: FROM, to, subject, text };
      if (inEmulator()) await getFirestore().doc('testMail/last').set({ ...lastFake, n: FieldValue.increment(1) }, { merge: true });
      return { sent: true, fake: true };
    }
    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: SMTP_USER, pass },
    });
    await transport.sendMail({ from: FROM, to, subject, text });
    return { sent: true };
  } catch (err) {
    logger.error('mailer: não enviou o e-mail', { err: safeErr(err) });
    return { sent: false };
  }
}

module.exports = { sendMail, __lastFake: () => lastFake };
