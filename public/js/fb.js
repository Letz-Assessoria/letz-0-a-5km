// Firebase no app: sessão (Auth + users/{uid} ao vivo), cadastro, login e
// retomada do pagamento. Expõe window.LetzFB e dispara 'letzfb-ready' no document.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getFirestore, connectFirestoreEmulator, doc, collection, onSnapshot, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  query, where, orderBy, limit, runTransaction, serverTimestamp, Timestamp, deleteField,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';
import { getStorage, connectStorageEmulator, ref as sref, uploadBytes, getDownloadURL, deleteObject } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';

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

// LetzCore (lib/core.js) é carregado antes deste módulo; domínio desconhecido = PROD.
const envName = window.LetzCore.projectForHost(location.hostname);
const config = envName === 'local' ? LOCAL : envName === 'dev' ? DEV : PROD;
const host = location.hostname;
const local = envName === 'local';

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

// Senha nova por link da Letz (callables públicos; o e-mail sai do servidor).
const callRequestReset = httpsCallable(functions, 'requestPasswordReset');
const callResetWithToken = httpsCallable(functions, 'resetPasswordWithToken');
const callAccessLink = httpsCallable(functions, 'createAccessLink');
async function resetPassword(email) {
  await callRequestReset({ email: String(email || '').trim() });
}
async function resetPasswordWithToken(token, password) {
  const r = await callResetWithToken({ token, password });
  return { email: r.data.email };
}
async function accessLink(uid) {
  const r = await callAccessLink({ uid });
  return { resetLink: r.data.resetLink };
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
  try {
    await login(data.email, data.password);
  } catch {
    throw Object.assign(new Error('Conta criada.'), { code: 'letz/account-created' });
  }
  return { checkoutUrl };
}

const AUTH_MSG = {
  'letz/account-created': 'Sua conta foi criada, mas não conseguimos entrar agora. Entre com seu e-mail e senha para concluir o pagamento.',
  'letz/handle-taken': 'Esse @ já está em uso. Escolha outro.',
  'permission-denied': 'Isso não é permitido agora. Confira se a semana já abriu e se o seu acesso está ativo.',
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

// ---------- dados do aluno (Firestore e Storage) ----------
const JPEG = { contentType: 'image/jpeg' };
const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : (typeof t === 'number' ? t : null));

function mine() {
  const s = session;
  if (!s || !s.user || !s.doc) throw Object.assign(new Error('Sessão não encontrada.'), { code: 'unauthenticated' });
  return { uid: s.user.uid, u: s.doc };
}
const postId = (uid, w, d) => `${uid}_${w}-${d}`;
const postRef = (w, d) => { const { uid } = mine(); return doc(db, 'posts', postId(uid, w, d)); };

// Roda `start(session)` quando a sessão permite e refaz se o usuário trocar; devolve o "parar".
function whenSession(ok, start) {
  let stop = null;
  let key = null;
  const off = onSession((s) => {
    const k = ok(s) ? s.user.uid : null;
    if (k === key) return;
    if (stop) { stop(); stop = null; }
    key = k;
    if (k) stop = start(s);
  });
  return () => { off(); if (stop) stop(); stop = null; };
}
const canRead = (s) => !!(s && s.user && ((s.claims && s.claims.admin === true) || (s.doc && s.doc.access === 'active')));
const isAthlete = (s) => !!(s && s.user && s.doc && s.doc.access === 'active' && !(s.claims && s.claims.admin));
const fail = (err) => console.error(err);

const mapPost = (d) => {
  const x = d.data({ serverTimestamps: 'estimate' });
  return { ...x, id: d.id, at: ms(x.at) || Date.now() };
};

// Perfil: foto em avatars/{uid}.jpg e, numa transação, users/{uid} + reserva do @ em handles/.
async function saveProfile({ name, handle, photoBlob }) {
  const { uid, u } = mine();
  const old = u.handle || '';
  const hRef = doc(db, 'handles', handle);
  const taken = () => Object.assign(new Error('Esse @ já está em uso.'), { code: 'letz/handle-taken' });
  if (handle !== old) {
    const s = await getDoc(hRef);
    if (s.exists() && s.data().uid !== uid) throw taken();
  }
  let photoURL = u.photoURL || '';
  if (photoBlob) {
    const r = sref(storage, `avatars/${uid}.jpg`);
    await uploadBytes(r, photoBlob, JPEG);
    photoURL = await getDownloadURL(r);
  }
  try {
    await runTransaction(db, async (tx) => {
      const hs = await tx.get(hRef);
      if (hs.exists() && hs.data().uid !== uid) throw taken();
      if (!hs.exists()) tx.set(hRef, { uid });
      tx.update(doc(db, 'users', uid), { name, handle, photoURL, profiled: true });
      if (old && old !== handle) tx.delete(doc(db, 'handles', old));
    });
  } catch (err) {
    if (err && err.code === 'permission-denied' && handle !== old) throw taken();
    throw err;
  }
}

// Treinos: um post por treino; a Function soma os pontos.
async function markWelcomed() {
  const { uid } = mine();
  await updateDoc(doc(db, 'users', uid), { welcomed: true });
}

async function markWorkout(w, d) {
  const { uid, u } = mine();
  await setDoc(postRef(w, d), {
    uid, handle: u.handle, name: u.name, photoURL: u.photoURL || '', w, d, at: serverTimestamp(),
    comment: '', photoPath: '', imgURL: '', hidden: false, authorActive: true,
  });
}

async function unmarkWorkout(w, d) {
  const { uid } = mine();
  const r = postRef(w, d);
  // Os comentários são de quem comentou: as regras só deixam apagar os próprios (melhor esforço).
  try {
    const cs = await getDocs(collection(r, 'comments'));
    await Promise.all(cs.docs.map((c) => deleteDoc(c.ref).catch(() => {})));
  } catch (err) { fail(err); }
  await deleteDoc(r);
  try { await deleteObject(sref(storage, `workouts/${uid}/${w}-${d}.jpg`)); } catch { /* sem foto */ }
}

async function setWorkoutContent(w, d, { comment, photoBlob }) {
  const { uid } = mine();
  const patch = {};
  if (typeof comment === 'string') patch.comment = comment;
  if (photoBlob) {
    const path = `workouts/${uid}/${w}-${d}.jpg`;
    const r = sref(storage, path);
    await uploadBytes(r, photoBlob, JPEG);
    patch.photoPath = path;
    patch.imgURL = await getDownloadURL(r);
  }
  await updateDoc(postRef(w, d), patch);
}

async function clearWorkoutContent(w, d, what) {
  const { uid } = mine();
  if (what === 'photo') {
    await updateDoc(postRef(w, d), { photoPath: '', imgURL: '' });
    try { await deleteObject(sref(storage, `workouts/${uid}/${w}-${d}.jpg`)); } catch { /* já não existe */ }
  } else {
    await updateDoc(postRef(w, d), { comment: '' });
  }
}

// Post da medalha: um por aluno (id {uid}_medal), sem pontos; as regras exigem o pedido enviado.
async function postMedal({ comment, photoBlob }) {
  const { uid, u } = mine();
  const data = {
    uid, handle: u.handle, name: u.name, photoURL: u.photoURL || '', medal: true, at: serverTimestamp(),
    comment: typeof comment === 'string' ? comment : '', photoPath: '', imgURL: '', hidden: false, authorActive: true,
  };
  if (photoBlob) {
    const path = `workouts/${uid}/medal.jpg`;
    const r = sref(storage, path);
    await uploadBytes(r, photoBlob, JPEG);
    data.photoPath = path;
    data.imgURL = await getDownloadURL(r);
  }
  await setDoc(doc(db, 'posts', `${uid}_medal`), data);
}

// Post da medalha do próprio aluno ao vivo; cb(null) enquanto não existe.
function watchMyMedalPost(cb) {
  return whenSession(isAthlete, (s) => onSnapshot(doc(db, 'posts', `${s.user.uid}_medal`),
    (snap) => cb(snap.exists() ? mapPost(snap) : null), (err) => { fail(err); cb(null); }));
}

function watchMyPosts(cb) {
  return whenSession(isAthlete, (s) => onSnapshot(
    query(collection(db, 'posts'), where('uid', '==', s.user.uid)),
    (snap) => cb(snap.docs.map(mapPost)), (err) => { fail(err); cb([]); },
  ));
}

// Feed da turma: do mais novo para o mais antigo, `pageSize` por vez (loadMoreFeed traz mais).
let feedSize = 20;
let feedStep = 20;
let feedRestart = null;
function watchFeed(cb, pageSize = 20) {
  feedStep = pageSize;
  feedSize = pageSize;
  let off = null;
  const run = () => {
    if (off) off();
    off = whenSession(canRead, () => onSnapshot(
      query(collection(db, 'posts'), where('authorActive', '==', true), orderBy('at', 'desc'), limit(feedSize)),
      (snap) => cb(snap.docs.map(mapPost), { more: snap.size >= feedSize }),
      (err) => { fail(err); cb([], { more: false, error: true }); },
    ));
  };
  feedRestart = run;
  run();
  return () => { feedRestart = null; if (off) off(); off = null; };
}
function loadMoreFeed() {
  feedSize += feedStep;
  if (feedRestart) feedRestart();
}

function watchRanking(cb) {
  return whenSession(canRead, () => onSnapshot(
    query(collection(db, 'users'), where('access', '==', 'active'), orderBy('points', 'desc')),
    (snap) => cb(snap.docs.map((d) => ({ uid: d.id, ...d.data() }))),
    (err) => { fail(err); cb([], { error: true }); },
  ));
}

function watchConfig(cb) {
  return whenSession(canRead, () => onSnapshot(doc(db, 'config', 'app'),
    (snap) => {
      if (!snap.exists()) { cb(null); return; }
      const x = snap.data();
      cb({ ...x, start: ms(x.start) });
    },
    (err) => { fail(err); cb(null); }));
}

// Reações: um doc por aluno em posts/{id}/reactions/{uid}; a Function conta em posts.rc.
async function loadMyReactions(ids) {
  const { uid } = mine();
  const out = {};
  await Promise.all(ids.map(async (id) => {
    try {
      const s = await getDoc(doc(db, 'posts', id, 'reactions', uid));
      out[id] = s.exists() ? s.data() : {};
    } catch (err) { fail(err); }
  }));
  return out;
}

async function toggleReaction(id, r) {
  const { uid } = mine();
  const rr = doc(db, 'posts', id, 'reactions', uid);
  const s = await getDoc(rr);
  const cur = s.exists() ? s.data() : {};
  const next = { oi: false, clap: false, fire: false, power: false, love: false, ...cur, [r]: !cur[r] };
  await setDoc(rr, next);
  return next;
}

async function addComment(id, text) {
  const { uid, u } = mine();
  await addDoc(collection(db, 'posts', id, 'comments'), {
    uid, handle: u.handle, text, at: serverTimestamp(), hidden: false,
  });
}
async function deleteComment(id, cid) {
  await deleteDoc(doc(db, 'posts', id, 'comments', cid));
}
function watchComments(id, cb) {
  return whenSession(canRead, () => onSnapshot(
    query(collection(db, 'posts', id, 'comments'), orderBy('at', 'asc')),
    (snap) => cb(snap.docs.map((d) => {
      const x = d.data({ serverTimestamps: 'estimate' });
      return { ...x, id: d.id, at: ms(x.at) || Date.now() };
    })),
    fail,
  ));
}

// ---------- medalha e reembolso (callables; o pedido em private/medal só as Functions escrevem) ----------
const callMedalCheckout = httpsCallable(functions, 'startMedalCheckout');
const callRefund = httpsCallable(functions, 'requestRefund');
const callRebuy = httpsCallable(functions, 'rebuyProgram');

// data: { useSignupAddress: true } ou { address: { cep, street, number, complement, district, city, uf } }.
async function startMedalCheckout(data) {
  const r = await callMedalCheckout(data);
  return { checkoutUrl: r.data.checkoutUrl };
}
async function requestRefund(product) {
  await callRefund({ product });
}
async function rebuyProgram() {
  const r = await callRebuy();
  return { checkoutUrl: r.data.checkoutUrl };
}

// Endereço do cadastro (private/profile.address); null se a conta não tem (conta antiga).
async function loadSignupAddress() {
  const { uid } = mine();
  const snap = await getDoc(doc(db, 'users', uid, 'private', 'profile'));
  return snap.exists() ? (snap.data().address || null) : null;
}
// Pedido da medalha ao vivo (sem a URL do checkout); cb(null) se ainda não existe.
function watchMedal(cb) {
  return whenSession(isAthlete, (s) => onSnapshot(doc(db, 'users', s.user.uid, 'private', 'medal'),
    (snap) => {
      if (!snap.exists()) { cb(null); return; }
      const x = snap.data({ serverTimestamps: 'estimate' });
      cb({
        status: x.status || 'pending', address: x.address || null, trackingCode: x.trackingCode || '',
        shippedAt: x.shippedAt || '', deliveredAt: x.deliveredAt || '', paidAt: ms(x.paidAt),
        refundCount: Number(x.refundCount) || 0, refundRequestedAt: ms(x.refundRequestedAt),
      });
    },
    (err) => { fail(err); cb(null); }));
}
// Cobrança do programa ao vivo (aluno ativo ou bloqueado): prazo do reembolso e limite de recompra.
function watchBilling(cb) {
  return whenSession((s) => !!(s && s.user && s.doc && (s.doc.access === 'active' || s.doc.access === 'blocked') && !(s.claims && s.claims.admin)),
    (s) => onSnapshot(doc(db, 'users', s.user.uid, 'private', 'billing'),
      (snap) => {
        const x = snap.exists() ? snap.data() : null;
        cb(x ? { status: x.status || '', paidAt: ms(x.paidAt), refundCount: Number(x.refundCount) || 0, refundRequestedAt: ms(x.refundRequestedAt) } : null);
      },
      (err) => { fail(err); cb(null); }));
}

// ---------- painel do treinador (regras: só com a claim admin) ----------
// Config: start vira Timestamp; null apaga o campo. merge mantém o resto do config/app.
function cfgValue(v) {
  if (v === null) return deleteField();
  if (Array.isArray(v) || typeof v !== 'object') return v;
  const o = {};
  Object.keys(v).forEach((k) => { o[k] = cfgValue(v[k]); });
  return o;
}
async function saveConfig(patch) {
  const data = {};
  Object.keys(patch).forEach((k) => {
    data[k] = k === 'start' && typeof patch[k] === 'number' ? Timestamp.fromMillis(patch[k]) : cfgValue(patch[k]);
  });
  await setDoc(doc(db, 'config', 'app'), data, { merge: true });
}

// Lista ao vivo: users + private/profile, billing de cada aluno (sem CPF).
function athleteRow(uid, u, p, b) {
  return {
    uid, name: u.name || '', handle: u.handle || '', access: u.access || 'pending',
    points: Number(u.points) || 0, done: Number(u.done) || 0, createdAt: ms(u.createdAt), profiled: u.profiled === true,
    email: (p && p.email) || '', phone: (p && p.phone) || '',
    city: (p && p.address && p.address.city) || '', uf: (p && p.address && p.address.uf) || '',
    billing: b ? {
      status: b.status || 'pending', method: b.method || '', installments: Number(b.installments) || 0,
      paidAt: ms(b.paidAt), duplicate: !!b.duplicate, cpfConflict: !!b.cpfConflict,
      coupon: b.coupon || '', percent: Number(b.percent) || 0, value: typeof b.value === 'number' ? b.value : null, partner: b.partner === true,
      refundRequestedAt: ms(b.refundRequestedAt), refundCount: Number(b.refundCount) || 0,
    } : null,
  };
}
const athletes = new Map();
let athletesEmit = null;
async function loadAthlete(uid, u) {
  const read = async (n) => { try { const s = await getDoc(doc(db, 'users', uid, 'private', n)); return s.exists() ? s.data() : null; } catch { return null; } };
  const [p, b] = await Promise.all([read('profile'), read('billing')]);
  athletes.set(uid, athleteRow(uid, u, p, b));
}
function emitAthletes() {
  if (athletesEmit) athletesEmit(Array.from(athletes.values()).sort((a, c) => (c.createdAt || 0) - (a.createdAt || 0)));
}
function listAthletes(cb) {
  athletes.clear();
  athletesEmit = cb;
  let alive = true;
  const off = whenSession((s) => !!(s && s.user && s.claims && s.claims.admin === true), () => onSnapshot(
    collection(db, 'users'),
    async (snap) => {
      const ch = snap.docChanges();
      ch.filter((c) => c.type === 'removed').forEach((c) => athletes.delete(c.doc.id));
      await Promise.all(ch.filter((c) => c.type !== 'removed').map((c) => loadAthlete(c.doc.id, c.doc.data())));
      if (alive) emitAthletes();
    },
    (err) => { fail(err); if (alive) cb([]); },
  ));
  return () => { alive = false; athletesEmit = null; athletes.clear(); off(); };
}
// Alertas de pagamento (escritos pelo webhook): só os não resolvidos, mais novos primeiro.
function listAlerts(cb) {
  return whenSession((s) => !!(s && s.user && s.claims && s.claims.admin === true), () => onSnapshot(
    query(collection(db, 'alerts'), where('resolved', '==', false)),
    (snap) => cb(snap.docs.map((d) => {
      const x = d.data();
      return { id: d.id, type: x.type || '', uid: x.uid || null, checkoutId: x.checkoutId || null, at: ms(x.at) };
    }).sort((a, c) => (c.at || 0) - (a.at || 0))),
    (err) => { fail(err); cb([]); },
  ));
}
// Financeiro (payments/{checkoutId}, escrito só pelo webhook): todas as compras ao vivo.
function listPayments(cb) {
  return whenSession((s) => !!(s && s.user && s.claims && s.claims.admin === true), () => onSnapshot(
    collection(db, 'payments'),
    (snap) => cb(snap.docs.map((d) => {
      const x = d.data();
      return {
        checkoutId: d.id, uid: x.uid || '', status: x.status || '', method: x.method || '',
        installments: Number(x.installments) || 0, gross: Number(x.gross) || 0,
        net: typeof x.net === 'number' ? x.net : null, product: x.product || '', kind: x.kind || '',
        coupon: x.coupon || '', percent: Number(x.percent) || 0,
        paidAt: ms(x.paidAt), updatedAt: ms(x.updatedAt),
      };
    })),
    (err) => { fail(err); cb([]); },
  ));
}
// Pedidos de medalha (admin): quem concluiu (users.concluded) + private/medal de cada um.
// Um listener por pedido: depois da primeira leitura só chegam as mudanças, sem reler a turma toda.
const callUpdateMedal = httpsCallable(functions, 'updateMedalOrder');
const callResendMedal = httpsCallable(functions, 'resendMedalEmail');
function medalOrderRow(uid, u, m) {
  const st = m && ['paid', 'shipped', 'delivered', 'refunded'].includes(m.status) ? m.status : 'none';
  return {
    uid, name: u.name || '', handle: u.handle || '', status: st,
    address: (m && m.address) || null, paidAt: ms(m && m.paidAt),
    trackingCode: (m && m.trackingCode) || '', shippedAt: (m && m.shippedAt) || '', deliveredAt: (m && m.deliveredAt) || '',
    emailedAt: ms(m && m.emailedAt), emailedCount: Number(m && m.emailedCount) || 0,
    refundRequestedAt: ms(m && m.refundRequestedAt), refundCount: Number((m && m.refundCount) || 0),
  };
}
function listMedalOrders(cb) {
  const users = new Map(); // uid -> dados do usuário
  const via = new Map(); // uid -> consultas que o incluem ('concluded' e/ou 'order')
  const orders = new Map();
  const subs = new Map();
  let alive = true;
  const emit = () => {
    if (!alive) return;
    for (const uid of users.keys()) if (!orders.has(uid)) return;
    cb(Array.from(users, ([uid, u]) => medalOrderRow(uid, u, orders.get(uid))).sort((a, c) => (a.name || '').localeCompare(c.name || '', 'pt-BR')));
  };
  const watch = (uid) => onSnapshot(doc(db, 'users', uid, 'private', 'medal'),
    (snap) => { orders.set(uid, snap.exists() ? snap.data({ serverTimestamps: 'estimate' }) : null); emit(); },
    (err) => { fail(err); orders.set(uid, null); emit(); });
  // Duas consultas: quem concluiu (users.concluded) e quem tem pedido (users.medalOrder, gravado
  // pelo servidor ao abrir o pedido). Quem tem pedido continua na lista mesmo sem concluded.
  const listen = (key, field) => onSnapshot(
    query(collection(db, 'users'), where(field, '==', true)),
    (snap) => {
      snap.docChanges().forEach((c) => {
        const uid = c.doc.id;
        const set = via.get(uid) || new Set();
        if (c.type === 'removed') set.delete(key); else set.add(key);
        via.set(uid, set);
        if (!set.size) {
          via.delete(uid); users.delete(uid); orders.delete(uid);
          if (subs.has(uid)) { subs.get(uid)(); subs.delete(uid); }
        } else if (c.type !== 'removed') {
          users.set(uid, c.doc.data());
          if (!subs.has(uid)) subs.set(uid, watch(uid));
        }
      });
      emit();
    },
    (err) => { fail(err); if (alive) cb([]); },
  );
  const off = whenSession((s) => !!(s && s.user && s.claims && s.claims.admin === true), () => {
    const offs = [listen('concluded', 'concluded'), listen('order', 'medalOrder')];
    return () => offs.forEach((f) => f());
  });
  return () => { alive = false; off(); subs.forEach((f) => f()); subs.clear(); };
}
// Datas AAAA-MM-DD em texto; sem data o servidor usa hoje. Devolve { emailed }.
async function updateMedalOrder({ uid, status, trackingCode, shippedAt, deliveredAt }) {
  const data = { uid, status };
  if (trackingCode !== undefined) data.trackingCode = trackingCode;
  if (shippedAt) data.shippedAt = shippedAt;
  if (deliveredAt) data.deliveredAt = deliveredAt;
  const r = await callUpdateMedal(data);
  return { emailed: r.data.emailed === true };
}
async function resendMedalEmail(uid) {
  const r = await callResendMedal({ uid });
  return { emailed: r.data.emailed === true };
}
// Parceiros e cupons (admin). createPartner/createCoupon são callables; a lista é ao vivo.
const callCreatePartner = httpsCallable(functions, 'createPartner');
const callCreateCoupon = httpsCallable(functions, 'createCoupon');
async function createPartner(data) {
  const r = await callCreatePartner(data);
  return { uid: r.data.uid, code: r.data.code, resetLink: r.data.resetLink };
}
async function createCoupon(data) {
  const r = await callCreateCoupon(data);
  return { code: r.data.code };
}
function listCoupons(cb) {
  return whenSession((s) => !!(s && s.user && s.claims && s.claims.admin === true), () => onSnapshot(
    collection(db, 'coupons'),
    (snap) => cb(snap.docs.map((d) => {
      const x = d.data();
      return {
        code: d.id, partnerUid: x.partnerUid || '', partnerName: x.partnerName || '', active: x.active === true,
        percent: Number(x.percent) || 0, maxUses: typeof x.maxUses === 'number' ? x.maxUses : null,
        usedCount: Number(x.usedCount) || 0, convertedCount: Number(x.convertedCount) || 0,
        expiresAt: ms(x.expiresAt), createdAt: ms(x.createdAt),
      };
    }).sort((a, c) => (c.createdAt || 0) - (a.createdAt || 0))),
    (err) => { fail(err); cb([]); },
  ));
}
async function listCouponUses(code) {
  const snap = await getDocs(collection(db, 'coupons', String(code), 'uses'));
  return snap.docs.map((d) => {
    const x = d.data();
    return {
      uid: d.id, name: x.name || '', partnerUid: x.partnerUid || '', at: ms(x.at),
      status: x.status || 'signed-up', convertedAt: ms(x.convertedAt), refundedAt: ms(x.refundedAt),
    };
  }).sort((a, c) => (c.at || 0) - (a.at || 0));
}
async function setCouponActive(code, active) {
  await updateDoc(doc(db, 'coupons', String(code)), { active: !!active });
}
async function setCouponMax(code, n) {
  // Em branco = sem limite.
  const blank = n === null || n === undefined || String(n).trim() === '';
  const v = blank ? null : Number(n);
  if (!blank && (!Number.isInteger(v) || v < 1 || v > 5000)) throw new Error('limite inválido');
  await updateDoc(doc(db, 'coupons', String(code)), { maxUses: v });
}
async function setCouponPercent(code, n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1 || v > 50) throw new Error('desconto inválido');
  await updateDoc(doc(db, 'coupons', String(code)), { percent: v });
}
async function resolveAlert(id) {
  await updateDoc(doc(db, 'alerts', id), { resolved: true });
}
async function setAccess(uid, access) {
  if (access !== 'active' && access !== 'blocked') throw new Error('acesso inválido');
  await updateDoc(doc(db, 'users', uid), { access });
}
async function setPostHidden(postId, hidden) {
  await updateDoc(doc(db, 'posts', postId), { hidden: !!hidden });
}
async function setCommentHidden(postId, cid, hidden) {
  await updateDoc(doc(db, 'posts', postId, 'comments', cid), { hidden: !!hidden });
}
window.LetzFB = {
  app, auth, db, functions, storage,
  onSession, signup, login, logout, resetPassword, resetPasswordWithToken, accessLink, resumeCheckout, errorMessage,
  saveProfile, markWelcomed, markWorkout, unmarkWorkout, setWorkoutContent, clearWorkoutContent,
  watchMyPosts, watchFeed, loadMoreFeed, watchRanking, watchConfig,
  loadMyReactions, toggleReaction, addComment, deleteComment, watchComments,
  postMedal, watchMyMedalPost,
  startMedalCheckout, requestRefund, rebuyProgram, loadSignupAddress, watchMedal, watchBilling,
  saveConfig, listAthletes, listMedalOrders, updateMedalOrder, resendMedalEmail, listAlerts, listPayments, resolveAlert, createPartner, createCoupon, listCoupons, listCouponUses, setCouponActive, setCouponMax, setCouponPercent, setAccess, setPostHidden, setCommentHidden,
};
document.dispatchEvent(new Event('letzfb-ready'));
