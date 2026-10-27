// Texto de erro para log sem CPF nem IP (mensagens do Firestore podem trazer o
// caminho cpfs/{cpf}). CPF em nenhuma forma (nem hash) vai para o log; os uids bastam.
function safeErr(err) {
  return String(err)
    .replace(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g, '[cpf]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]')
    .replace(/\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b/gi, '[ip]');
}

module.exports = { safeErr };
