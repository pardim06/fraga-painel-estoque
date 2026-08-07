// scripts/postar-resposta.js
//
// Publica manualmente no ML uma resposta que já foi gerada e está salva em
// respostas-sugeridas.json (sem esperar o horário automático) — usado pra
// aprovar na hora um caso específico, sem regenerar o texto.
//
// Uso: node scripts/postar-resposta.js <questionId>

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const axios = require('axios');
const { getMLAccessToken } = require('../lib/tokens');

const ESTADO_PATH = path.join(__dirname, '..', 'respostas-sugeridas.json');
const HISTORICO_PATH = path.join(__dirname, '..', 'historico-respostas-ia.json');

async function main() {
  const questionId = process.argv[2];
  if (!questionId) {
    console.error('Uso: node scripts/postar-resposta.js <questionId>');
    process.exit(1);
  }

  const estado = JSON.parse(fs.readFileSync(ESTADO_PATH, 'utf8'));
  const registro = estado[questionId];
  if (!registro) {
    console.error(`Nenhuma resposta gerada encontrada pra pergunta ${questionId}`);
    process.exit(1);
  }

  const token = await getMLAccessToken();
  await axios.post(
    'https://api.mercadolibre.com/answers',
    { question_id: Number(questionId), text: registro.resposta },
    { headers: { Authorization: `Bearer ${token}` } }
  );

  registro.status = 'auto_respondida';
  registro.respondidoEm = new Date().toISOString();
  fs.writeFileSync(ESTADO_PATH, JSON.stringify(estado, null, 2));

  if (fs.existsSync(HISTORICO_PATH)) {
    try {
      const historico = JSON.parse(fs.readFileSync(HISTORICO_PATH, 'utf8'));
      if (historico[questionId]) {
        historico[questionId] = registro;
        fs.writeFileSync(HISTORICO_PATH, JSON.stringify(historico, null, 2));
      }
    } catch {
      // histórico é só pra acompanhamento no painel — se falhar, não impede a publicação
    }
  }

  console.log(`Resposta publicada no ML pra pergunta ${questionId}.`);
}

main().catch((err) => {
  console.error('Erro ao publicar resposta:', err.response?.data || err.message);
  process.exit(1);
});
