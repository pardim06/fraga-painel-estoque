// scripts/responder-perguntas.js
//
// Pra cada pergunta nova em aberto no Mercado Livre (lida de perguntas-ml.json,
// já gerado pelo verificar-perguntas.js), pede pra Claude sugerir uma
// resposta e manda pro dono aprovar via WhatsApp/e-mail — NADA é publicado
// automaticamente no ML, é só rascunho. O dono decide se copia e cola no app
// do Mercado Livre.
//
// Só gera rascunho novo pra pergunta que ainda não foi notificada antes
// (controlado por respostas-sugeridas.json), pra não gastar chamada da API
// nem repetir a mesma notificação a cada ciclo enquanto a pergunta segue em aberto.

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const axios = require('axios');
const { getMLAccessToken } = require('../lib/tokens');
const { gerarRespostaSugerida } = require('../lib/gemini');
const { enviarNotificacao } = require('../lib/notificar');

const PERGUNTAS_PATH = path.join(__dirname, '..', 'perguntas-ml.json');
const ESTADO_PATH = path.join(__dirname, '..', 'respostas-sugeridas.json');

function lerJson(caminho) {
  if (!fs.existsSync(caminho)) return null;
  try {
    return JSON.parse(fs.readFileSync(caminho, 'utf8'));
  } catch {
    return null;
  }
}

const cacheDescricao = new Map();
async function getDescricaoItem(accessToken, itemId) {
  if (cacheDescricao.has(itemId)) return cacheDescricao.get(itemId);
  let descricao = '';
  try {
    const resp = await axios.get(`https://api.mercadolibre.com/items/${itemId}/description`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    descricao = resp.data?.plain_text || resp.data?.text || '';
  } catch {
    descricao = '';
  }
  cacheDescricao.set(itemId, descricao);
  return descricao;
}

function formatarNotificacao(rascunhos) {
  const separador = '----------------------------';
  let corpo = `*SUGESTAO DE RESPOSTA - PERGUNTAS ML*\n${rascunhos.length} pergunta(s) nova(s) com rascunho pronto\n`;

  for (const r of rascunhos) {
    corpo +=
      `\n${separador}\n` +
      `*${r.produto}*\n` +
      `Pergunta: ${r.pergunta}\n\n` +
      `Sugestao de resposta:\n${r.resposta}\n`;
  }

  corpo += `\n${separador}\nRevise antes de enviar - copie e cole no app do Mercado Livre se estiver de acordo.`;
  return corpo;
}

async function main() {
  const perguntasData = lerJson(PERGUNTAS_PATH);
  if (!perguntasData || !Array.isArray(perguntasData.perguntas)) {
    console.log('perguntas-ml.json ainda não existe ou está vazio — nada a fazer.');
    return;
  }

  const abertasIds = new Set(perguntasData.perguntas.map((p) => String(p.id)));
  let estado = lerJson(ESTADO_PATH) || {};

  // Limpa do estado quem não está mais em aberto (foi respondida ou expirou) —
  // assim, se a MESMA pergunta reaparecer um dia (não deveria, mas por
  // segurança), ganha um rascunho novo em vez de ficar presa num estado velho.
  for (const id of Object.keys(estado)) {
    if (!abertasIds.has(id)) delete estado[id];
  }

  const novas = perguntasData.perguntas.filter((p) => !estado[String(p.id)]);

  if (novas.length === 0) {
    fs.writeFileSync(ESTADO_PATH, JSON.stringify(estado, null, 2));
    console.log('Nenhuma pergunta nova sem rascunho. Nada a notificar.');
    return;
  }

  const token = await getMLAccessToken();
  const rascunhos = [];

  for (const p of novas) {
    try {
      const descricao = await getDescricaoItem(token, p.itemId);
      const resposta = await gerarRespostaSugerida({
        produto: p.produto,
        descricao,
        pergunta: p.texto,
      });

      const registro = {
        pergunta: p.texto,
        resposta,
        produto: p.produto,
        link: p.link,
        geradoEm: new Date().toISOString(),
      };

      estado[String(p.id)] = registro;
      rascunhos.push(registro);
    } catch (err) {
      console.error(`Erro ao gerar resposta pra pergunta ${p.id}:`, err.response?.data || err.message);
    }
  }

  fs.writeFileSync(ESTADO_PATH, JSON.stringify(estado, null, 2));

  if (rascunhos.length > 0) {
    await enviarNotificacao(formatarNotificacao(rascunhos), `${rascunhos.length} sugestão(ões) de resposta pra aprovar`);
    console.log(`${rascunhos.length} rascunho(s) gerado(s) e notificado(s).`);
  } else {
    console.log('Nenhum rascunho gerado com sucesso.');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Erro ao gerar respostas sugeridas:', err.response?.data || err.message);
    process.exit(1);
  });
}
