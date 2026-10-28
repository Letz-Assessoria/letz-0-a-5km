#!/usr/bin/env node
// Uso: node scripts/set-admin.mjs --project <dev|prod|id> --email <email> [--remove]
// Define/remove a claim admin:true. Credenciais: ADC (gcloud auth application-default login)
// ou emulador (FIREBASE_AUTH_EMULATOR_HOST). O e-mail vem só do argumento.
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const PROJECTS = { dev: 'letz-0-aos-5km-dev', prod: 'letz-0-aos-5km' };

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    email: { type: 'string' },
    remove: { type: 'boolean', default: false },
    enable: { type: 'boolean', default: false },
  },
});

if (!values.project || !values.email) {
  console.error('Uso: node scripts/set-admin.mjs --project <dev|prod> --email <email> [--remove]');
  process.exit(2);
}

const projectId = PROJECTS[values.project] || values.project;
// apiKey web de cada projeto (pública, a mesma de public/js/fb.js); o link do Admin SDK sai com apiKey vazia.
const WEB_API_KEYS = {
  'letz-0-aos-5km': 'AIzaSyA6ohoB15NRgaLBFLRy8EacGgAAWXkXtaU',
  'letz-0-aos-5km-dev': 'AIzaSyCQ_c-OtMyMqMdKRYqt0mKEgA13-RyGPuU',
};
const withApiKey = (link) => (WEB_API_KEYS[projectId] ? link.replace(/([?&]apiKey=)(?=&|$)/, `$1${WEB_API_KEYS[projectId]}`) : link);
process.env.GCLOUD_PROJECT = projectId;
const auth = getAuth(initializeApp({ projectId }));

try {
  let user;
  let created = false;
  try {
    user = await auth.getUserByEmail(values.email);
  } catch (e) {
    if (e.code !== 'auth/user-not-found' || values.remove) throw e;
    user = await auth.createUser({
      email: values.email,
      password: randomBytes(24).toString('base64url'),
    });
    created = true;
    const link = withApiKey(await auth.generatePasswordResetLink(values.email));
    console.log(`Usuário criado: uid=${user.uid}`);
    console.log(`Link de redefinição de senha (envie ao treinador): ${link}`);
  }

  if (!created && !values.remove && user.disabled) {
    if (!values.enable) {
      throw new Error('conta desativada; nada foi alterado. Use --enable para reativar e conceder admin');
    }
    await auth.updateUser(user.uid, { disabled: false });
    console.log(`Conta reativada (--enable): uid=${user.uid}`);
  }

  if (!created && !values.remove && user.emailVerified !== true) {
    // Anti pre-hijacking: conta existente com e-mail não verificado pode ter sido
    // criada por terceiros. Retoma a conta antes de conceder admin.
    await auth.updateUser(user.uid, {
      password: randomBytes(24).toString('base64url'),
    });
    await auth.revokeRefreshTokens(user.uid);
    const link = withApiKey(await auth.generatePasswordResetLink(values.email));
    console.log(`Conta existente com e-mail não verificado: senha redefinida e sessões revogadas (uid=${user.uid}).`);
    console.log(`Link de redefinição de senha (envie ao treinador): ${link}`);
  }

  const claims = { ...(user.customClaims || {}) };
  if (values.remove) delete claims.admin;
  else claims.admin = true;
  await auth.setCustomUserClaims(user.uid, Object.keys(claims).length ? claims : null);

  if (values.remove) {
    await auth.revokeRefreshTokens(user.uid);
    console.log('Aviso: ID tokens já emitidos continuam válidos por até ~1h.');
  }
  console.log(`${values.remove ? 'admin removido' : 'admin definido'}: uid=${user.uid} (${values.email}) projeto=${projectId}`);
} catch (e) {
  console.error(`Erro: ${e.code || e.message}`);
  process.exit(1);
}
