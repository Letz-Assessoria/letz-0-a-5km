const { setGlobalOptions } = require('firebase-functions/v2');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { initializeApp, getApps } = require('firebase-admin/app');

if (!getApps().length) initializeApp();
setGlobalOptions({ region: 'southamerica-east1' });

const points = require('./src/points.js');
const propagate = require('./src/propagate.js');
const reactions = require('./src/reactions.js');

exports.onPostWritten = onDocumentWritten('posts/{postId}', points.onPostChange);
exports.onReactionWritten = onDocumentWritten('posts/{postId}/reactions/{uid}', reactions.onReactionChange);
exports.onUserWritten = onDocumentWritten('users/{uid}', propagate.onUserChange);
exports.onConfigWritten = onDocumentWritten({ document: 'config/app', timeoutSeconds: 300 }, points.onConfigChange);
