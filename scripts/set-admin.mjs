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
  },
});

if (!values.project || !values.email) {
  console.error('Uso: node scripts/set-admin.mjs --project <dev|prod> --email <email> [--remove]');
  process.exit(2);
}

const projectId = PROJECTS[values.project] || values.project;
process.env.GCLOUD_PROJECT = projectId;
const auth = getAuth(initializeApp({ projectId }));

try {
  let user;
  try {
    user = await auth.getUserByEmail(values.email);
  } catch (e) {
    if (e.code !== 'auth/user-not-found' || values.remove) throw e;
    user = await auth.createUser({
      email: values.email,
      password: randomBytes(24).toString('base64url'),
    });
    const link = await auth.generatePasswordResetLink(values.email);
    console.log(`Usuário criado: uid=${user.uid}`);
    console.log(`Link de redefinição de senha (envie ao treinador): ${link}`);
  }

  const claims = { ...(user.customClaims || {}) };
  if (values.remove) delete claims.admin;
  else claims.admin = true;
  await auth.setCustomUserClaims(user.uid, Object.keys(claims).length ? claims : null);

  console.log(`${values.remove ? 'admin removido' : 'admin definido'}: uid=${user.uid} (${values.email}) projeto=${projectId}`);
} catch (e) {
  console.error(`Erro: ${e.code || e.message}`);
  process.exit(1);
}
