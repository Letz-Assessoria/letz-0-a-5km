const { setGlobalOptions } = require('firebase-functions/v2');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { initializeApp, getApps } = require('firebase-admin/app');

if (!getApps().length) initializeApp();
setGlobalOptions({ region: 'southamerica-east1' });

const points = require('./src/points.js');
const propagate = require('./src/propagate.js');
const reactions = require('./src/reactions.js');
const { onCall, onRequest } = require('firebase-functions/v2/https');
const { ASAAS_API_KEY, ASAAS_WEBHOOK_TOKEN, GMAIL_APP_PASSWORD } = require('./src/billing-config.js');
const signup = require('./src/signup.js');
const partners = require('./src/partners.js');
const medal = require('./src/medal.js');
const webhook = require('./src/webhook.js');
const passwordReset = require('./src/password-reset.js');

exports.onPostWritten = onDocumentWritten('posts/{postId}', points.onPostChange);
exports.onReactionWritten = onDocumentWritten('posts/{postId}/reactions/{uid}', reactions.onReactionChange);
exports.onUserWritten = onDocumentWritten('users/{uid}', propagate.onUserChange);
exports.onConfigWritten = onDocumentWritten({ document: 'config/app', timeoutSeconds: 300 }, points.onConfigChange);

exports.signup = onCall({ secrets: [ASAAS_API_KEY] }, signup.signup);
exports.resumeCheckout = onCall({ secrets: [ASAAS_API_KEY] }, signup.resumeCheckout);
exports.rebuyProgram = onCall({ secrets: [ASAAS_API_KEY] }, signup.rebuyProgram);
exports.requestRefund = onCall(medal.requestRefund);
exports.startMedalCheckout = onCall({ secrets: [ASAAS_API_KEY] }, medal.startMedalCheckout);
// E-mail de envio da medalha: sai de letzassessoria@gmail.com com a senha de app no secret GMAIL_APP_PASSWORD.
exports.updateMedalOrder = onCall({ secrets: [GMAIL_APP_PASSWORD] }, medal.updateMedalOrder);
exports.resendMedalEmail = onCall({ secrets: [GMAIL_APP_PASSWORD] }, medal.resendMedalEmail);
// Senha nova por link da Letz; o e-mail sai de letzassessoria@gmail.com.
exports.requestPasswordReset = onCall({ secrets: [GMAIL_APP_PASSWORD] }, passwordReset.requestPasswordReset);
exports.createAccessLink = onCall(passwordReset.createAccessLink);
exports.resetPasswordWithToken = onCall(passwordReset.resetPasswordWithToken);
exports.createPartner = onCall(partners.createPartner);
exports.createCoupon = onCall(partners.createCoupon);
exports.asaasWebhook = onRequest({ secrets: [ASAAS_WEBHOOK_TOKEN] }, webhook.asaasWebhook);
