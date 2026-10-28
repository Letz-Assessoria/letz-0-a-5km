// E-mail transacional da Letz, via SMTP do Gmail (senha de app no secret GMAIL_APP_PASSWORD).
// Nunca lança: falha vira log e { sent: false }. O emulador sempre usa um transporte falso
// (guarda a última mensagem para os testes); em produção, sem o secret, devolve
// { sent: false, reason: 'not-configured' }, para ninguém achar que o e-mail saiu.
const nodemailer = require('nodemailer');
const logger = require('firebase-functions/logger');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { GMAIL_APP_PASSWORD } = require('./billing-config.js');
const { safeErr } = require('./safe.js');

const FROM = 'Letz Assessoria <letzassessoria@gmail.com>';
const SMTP_USER = 'letzassessoria@gmail.com';

let lastFake = null;
let warnedNotConfigured = false;

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
    // O emulador nunca envia e-mail de verdade, mesmo com um secret falso.
    if (inEmulator()) {
      lastFake = { from: FROM, to, subject, text };
      await getFirestore().doc('testMail/last').set({ ...lastFake, n: FieldValue.increment(1) }, { merge: true });
      return { sent: true, fake: true };
    }
    const pass = appPassword();
    if (!pass) {
      if (!warnedNotConfigured) {
        warnedNotConfigured = true;
        logger.warn('mailer: GMAIL_APP_PASSWORD não configurado; e-mails não serão enviados');
      }
      return { sent: false, reason: 'not-configured' };
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
