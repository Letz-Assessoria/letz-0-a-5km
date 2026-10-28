const { setGlobalOptions } = require('firebase-functions/v2');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { initializeApp, getApps } = require('firebase-admin/app');

if (!getApps().length) initializeApp();
setGlobalOptions({ region: 'southamerica-east1' });

const points = require('./src/points.js');
const propagate = require('./src/propagate.js');
const reactions = require('./src/reactions.js');
const { onCall, onRequest } = require('firebase-functions/v2/https');
const { ASAAS_API_KEY, ASAAS_WEBHOOK_TOKEN } = require('./src/billing-config.js');
const signup = require('./src/signup.js');
const partners = require('./src/partners.js');
const webhook = require('./src/webhook.js');

exports.onPostWritten = onDocumentWritten('posts/{postId}', points.onPostChange);
exports.onReactionWritten = onDocumentWritten('posts/{postId}/reactions/{uid}', reactions.onReactionChange);
exports.onUserWritten = onDocumentWritten('users/{uid}', propagate.onUserChange);
exports.onConfigWritten = onDocumentWritten({ document: 'config/app', timeoutSeconds: 300 }, points.onConfigChange);

exports.signup = onCall({ secrets: [ASAAS_API_KEY] }, signup.signup);
exports.resumeCheckout = onCall({ secrets: [ASAAS_API_KEY] }, signup.resumeCheckout);
exports.createPartner = onCall(partners.createPartner);
exports.createCoupon = onCall(partners.createCoupon);
exports.asaasWebhook = onRequest({ secrets: [ASAAS_WEBHOOK_TOKEN] }, webhook.asaasWebhook);
