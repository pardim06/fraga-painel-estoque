// scripts/verificar-perguntas.js
//
// Busca as perguntas em aberto (não respondidas) dos anúncios no Mercado
// Livre e salva pro painel (perguntas-ml.html). Roda com mais frequência que
// o verificador de estoque (ver .github/workflows/verificar-perguntas.yml),
// já que o prazo de resposta é medido em minutos/horas, não em dias.

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const axios = require('axios');
const { getMLAccessToken } = require('../lib/tokens');

const OUTPUT_PATH = path.join(__dirname, '..', 'perguntas-ml.json');
const ML_SELLER_ID = process.env.ML_SELLER_ID;

// Acima desse tempo sem resposta, a pergunta é destacada como atrasada no painel.
const LIMITE_MINUTOS = 60;

async function getPerguntasAbertas(accessToken) {
  const perguntas = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const resp = await axios.get('https://api.mercadolibre.com/questions/search', {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        seller_id: ML_SELLER_ID,
        status: 'UNANSWERED',
        sort_fields: 'date_created',
        sort_types: 'ASC',
        limit,
        offset,
      },
    });

    const dados = resp.data.questions || [];
    perguntas.push(...dados);

    if (dados.length < limit) break;
    offset += limit;
  }

  return perguntas;
}

// Busca o título e o link público dos anúncios em lote, pra mostrar junto da pergunta.
async function getInfoAnuncios(accessToken, itemIds) {
  const info = {};
  const idsUnicos = [...new Set(itemIds)];

  for (let i = 0; i < idsUnicos.length; i += 20) {
    const lote = idsUnicos.slice(i, i + 20);
    const resp = await axios.get('https://api.mercadolibre.com/items', {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { ids: lote.join(','), attributes: 'id,title,permalink' },
    });

    for (const entry of resp.data) {
      if (entry.code === 200) {
        info[entry.body.id] = { titulo: entry.body.title, link: entry.body.permalink };
      }
    }
  }

  return info;
}

function salvarResultado(perguntas, infoAnuncios) {
  const agora = Date.now();

  const lista = perguntas
    .map((p) => {
      const minutosAberta = Math.round((agora - new Date(p.date_created).getTime()) / 60000);
      const anuncio = infoAnuncios[p.item_id] || {};
      return {
        id: p.id,
        texto: p.text,
        itemId: p.item_id,
        produto: anuncio.titulo || p.item_id,
        link: anuncio.link || null,
        dataCriacao: p.date_created,
        minutosAberta,
        atrasada: minutosAberta > LIMITE_MINUTOS,
      };
    })
    .sort((a, b) => b.minutosAberta - a.minutosAberta);

  const resultado = {
    atualizadoEm: new Date().toISOString(),
    limiteMinutos: LIMITE_MINUTOS,
    total: lista.length,
    atrasadas: lista.filter((p) => p.atrasada).length,
    perguntas: lista,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(resultado, null, 2));
  console.log(`Resultado salvo em ${OUTPUT_PATH} (${lista.length} pergunta(s) em aberto, ${resultado.atrasadas} atrasada(s))`);
}

async function main() {
  const token = await getMLAccessToken();
  const perguntas = await getPerguntasAbertas(token);
  const infoAnuncios = await getInfoAnuncios(token, perguntas.map((p) => p.item_id));
  salvarResultado(perguntas, infoAnuncios);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Erro ao verificar perguntas:', err.response?.data || err.message);
    process.exit(1);
  });
}
