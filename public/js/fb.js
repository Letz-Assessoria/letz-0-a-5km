// Firebase no app: sessão (Auth + users/{uid} ao vivo), cadastro, login e
// retomada do pagamento. Expõe window.LetzFB e dispara 'letzfb-ready' no document.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getFirestore, connectFirestoreEmulator, doc, onSnapshot } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';
import { getStorage, connectStorageEmulator } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';

// Config Web (pública por natureza). prod só nos domínios de produção; o resto usa dev.
const PROD = {
  apiKey: 'AIzaSyA6ohoB15NRgaLBFLRy8EacGgAAWXkXtaU',
  authDomain: 'letz-0-aos-5km.firebaseapp.com',
  projectId: 'letz-0-aos-5km',
  storageBucket: 'letz-0-aos-5km.firebasestorage.app',
  messagingSenderId: '785596324218',
  appId: '1:785596324218:web:7236071298137576ba1ec3',
};
const DEV = {
  apiKey: 'AIzaSyCQ_c-OtMyMqMdKRYqt0mKEgA13-RyGPuU',
  authDomain: 'letz-0-aos-5km-dev.firebaseapp.com',
  projectId: 'letz-0-aos-5km-dev',
  storageBucket: 'letz-0-aos-5km-dev.firebasestorage.app',
  messagingSenderId: '508016104407',
  appId: '1:508016104407:web:a54d90e0e45afe69923192',
};
const LOCAL = { apiKey: 'fake-api-key', authDomain: 'localhost', projectId: 'demo-letz', storageBucket: 'demo-letz.appspot.com' };

const host = location.hostname;
const local = host === 'localhost' || host === '127.0.0.1';
const config = local ? LOCAL
  : (host === 'letz-0-aos-5km.web.app' || host === 'letz-0-aos-5km.firebaseapp.com') ? PROD : DEV;

const app = initializeApp(config);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, 'southamerica-east1');
const storage = getStorage(app);
if (local) {
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8080);
  connectFunctionsEmulator(functions, host, 5001);
  connectStorageEmulator(storage, host, 9199);
}

// ---------- sessão ----------
// undefined = ainda não sabemos; null = sem login; {user, claims, doc}.
let session;
const listeners = [];
let stopDoc = null;
let gen = 0;

function emit(s) {
  session = s;
  listeners.slice().forEach((cb) => {
    try { cb(s); } catch (err) { console.error(err); }
  });
}

onAuthStateChanged(auth, async (user) => {
  const my = ++gen;
  if (stopDoc) { stopDoc(); stopDoc = null; }
  if (!user) { emit(null); return; }
  let claims = {};
  try {
    claims = (await user.getIdTokenResult()).claims || {};
  } catch (err) {
    console.error(err);
  }
  if (my !== gen) return;
  if (claims.admin === true) { emit({ user, claims, doc: null }); return; }
  stopDoc = onSnapshot(doc(db, 'users', user.uid),
    (snap) => { if (my === gen) emit({ user, claims, doc: snap.exists() ? snap.data() : null }); },
    (err) => { console.error(err); if (my === gen) emit({ user, claims, doc: null }); });
});

function onSession(cb) {
  listeners.push(cb);
  if (session !== undefined) cb(session);
  return () => { const i = listeners.indexOf(cb); if (i > -1) listeners.splice(i, 1); };
}

// ---------- conta ----------
const callSignup = httpsCallable(functions, 'signup');
const callResume = httpsCallable(functions, 'resumeCheckout');

function login(email, password) {
  return signInWithEmailAndPassword(auth, String(email || '').trim(), password || '');
}

function logout() {
  return signOut(auth);
}

function resetPassword(email) {
  return sendPasswordResetEmail(auth, String(email || '').trim());
}

async function resumeCheckout() {
  const r = await callResume();
  return { checkoutUrl: r.data.checkoutUrl };
}

// Cria a conta pendente (callable), entra e devolve o link do checkout.
// Se o Asaas falhou depois de a conta existir ('unavailable'), entra mesmo assim
// e tenta abrir o checkout de novo; se ainda falhar, o erro sai com signedIn = true
// (a tela "Aguardando" mostra o erro e o botão "Concluir pagamento").
async function signup(data) {
  let checkoutUrl;
  try {
    const r = await callSignup(data);
    checkoutUrl = r.data.checkoutUrl;
  } catch (err) {
    if (err && err.code === 'functions/unavailable') {
      try {
        await login(data.email, data.password);
      } catch {
        throw err;
      }
      try {
        return await resumeCheckout();
      } catch (again) {
        // A conta existe e a pessoa já entrou: a mensagem certa é a da retomada.
        const e = again && again.code ? again : err;
        e.signedIn = true;
        throw e;
      }
    }
    throw err;
  }
  await login(data.email, data.password);
  return { checkoutUrl };
}

const AUTH_MSG = {
  'auth/invalid-credential': 'E-mail ou senha incorretos.',
  'auth/wrong-password': 'E-mail ou senha incorretos.',
  'auth/user-not-found': 'E-mail ou senha incorretos.',
  'auth/invalid-email': 'Confira o e-mail.',
  'auth/missing-password': 'Digite sua senha.',
  'auth/user-disabled': 'Esta conta foi desativada. Fale com a Letz.',
  'auth/too-many-requests': 'Muitas tentativas. Espere alguns minutos e tente de novo.',
  'auth/network-request-failed': 'Sem conexão. Confira sua internet e tente de novo.',
};
const FN_MSG = {
  'already-exists': 'Já existe um cadastro com este CPF ou e-mail. Entre com seu e-mail e senha ou fale com a Letz.',
  'invalid-argument': 'Confira os dados do cadastro.',
  unavailable: 'Não conseguimos abrir o pagamento agora. Tente de novo em alguns minutos.',
  'failed-precondition': 'Não foi possível continuar. Fale com a Letz.',
  'resource-exhausted': 'Muitas tentativas. Tente de novo em alguns minutos.',
  unauthenticated: 'Sua sessão expirou. Entre de novo.',
};

// Texto em português para o erro. Erros das Functions já vêm em português na
// mensagem (HttpsError); os do Auth são traduzidos aqui.
function errorMessage(err) {
  const code = String((err && err.code) || '');
  if (AUTH_MSG[code]) return AUTH_MSG[code];
  if (code.startsWith('functions/')) {
    const c = code.slice('functions/'.length);
    // O SDK acrescenta o status HTTP no fim ("... [400]"): sai.
    const m = String(err.message || '').replace(/\s*\[\d{3}\]\s*$/, '');
    // Mensagem própria do servidor (HttpsError). As genéricas do SDK são uma
    // palavra só ('internal', 'unavailable'...) e ficam com o texto de FN_MSG.
    if (c !== 'internal' && /\s/.test(m.trim())) return m;
    return FN_MSG[c] || 'Algo deu errado. Tente de novo.';
  }
  return 'Algo deu errado. Tente de novo.';
}

window.LetzFB = {
  app, auth, db, functions, storage,
  onSession, signup, login, logout, resetPassword, resumeCheckout, errorMessage,
};
document.dispatchEvent(new Event('letzfb-ready'));
