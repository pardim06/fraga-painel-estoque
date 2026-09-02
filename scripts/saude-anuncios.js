// scripts/saude-anuncios.js
//
// Verifica quais anúncios estão perdendo (ou em risco de perder) exposição
// no Mercado Livre por reclamação/cancelamento recente — usa o indicador
// oficial "reputation_health_gauge": unhealthy = já está perdendo alcance,
// warning = pode perder mas ainda dá pra recuperar. A API NÃO expõe o motivo
// exato (isso só aparece no painel de vendas do próprio ML). Como
// complemento, busca em /item/{id}/performance oportunidades de qualidade
// do anúncio (fotos, ficha técnica etc.) — é um dado útil à parte, não a
// causa confirmada da perda de exposição.
//
// Roda 1x/dia (encadeado no workflow de lista de compras, mesma cadência) —
// saúde de anúncio não muda de hora em hora.

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const axios = require('axios');
const { getMLAccessToken } = require('../lib/tokens');
const { enviarNotificacao } = require('../lib/notificar');
const { publicarDados } = require('../lib/supabase-publicar');

const ESTADO_PATH = path.join(__dirname, '..', 'saude-anuncios-estado.json');

function aguardar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buscarIdsPorSaude(accessToken, sellerId, status) {
  const ids = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const resp = await axios.get(`https://api.mercadolibre.com/users/${sellerId}/items/search`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { reputation_health_gauge: status, limit, offset },
    });

    const resultados = resp.data?.results || [];
    ids.push(...resultados);

    const total = resp.data?.paging?.total ?? resultados.length;
    offset += limit;
    if (offset >= total || resultados.length === 0) break;
  }

  return ids;
}

async function buscarDetalhePerformance(accessToken, itemId) {
  try {
    const resp = await axios.get(`https://api.mercadolibre.com/item/${itemId}/performance`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const dados = resp.data;

    const problemas = [];
    for (const bucket of dados.buckets || []) {
      for (const variavel of bucket.variables || []) {
        if (variavel.status !== 'PENDING') continue;
        for (const regra of variavel.rules || []) {
          if (regra.status !== 'PENDING') continue;
          problemas.push({
            titulo: regra.wordings?.title || variavel.title || variavel.key,
            tipo: regra.mode === 'WARNING' ? 'warning' : 'oportunidade',
            link: regra.wordings?.link || null,
          });
        }
      }
    }

    return { score: dados.score ?? null, level: dados.level_wording || dados.level || null, problemas };
  } catch {
    return { score: null, level: null, problemas: [] };
  }
}

async function buscarInfoAnuncios(accessToken, itemIds) {
  const info = {};
  for (let i = 0; i < itemIds.length; i += 20) {
    const lote = itemIds.slice(i, i + 20);
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

function lerEstado() {
  if (!fs.existsSync(ESTADO_PATH)) return { unhealthyIds: [] };
  try {
    return JSON.parse(fs.readFileSync(ESTADO_PATH, 'utf8'));
  } catch {
    return { unhealthyIds: [] };
  }
}

function formatarAlerta(itensNovos) {
  const LIMITE_ITENS = 15;
  const separador = '----------------------------';
  let corpo = `*ANUNCIO(S) PERDENDO EXPOSICAO NO ML*\n${itensNovos.length} anuncio(s) novo(s) por reclamacao/cancelamento recente\n`;
  for (const item of itensNovos.slice(0, LIMITE_ITENS)) {
    corpo += `\n${separador}\n*${item.titulo}*\n`;
  }
  if (itensNovos.length > LIMITE_ITENS) {
    corpo += `\n${separador}\n... e mais ${itensNovos.length - LIMITE_ITENS} anuncio(s). Veja todos no painel.\n`;
  }
  corpo += `\n${separador}\nO motivo exato so aparece no painel do proprio ML (Reputacao > Reclamacoes, cancelamentos e devolucoes). Veja a lista completa no painel (Saude dos Anuncios).`;
  return corpo;
}

async function main() {
  const token = await getMLAccessToken();
  const sellerId = process.env.ML_SELLER_ID;

  const [unhealthyIds, warningIds] = await Promise.all([
    buscarIdsPorSaude(token, sellerId, 'unhealthy'),
    buscarIdsPorSaude(token, sellerId, 'warning'),
  ]);

  const todosIds = [...new Set([...unhealthyIds, ...warningIds])];
  const infoAnuncios = await buscarInfoAnuncios(token, todosIds);

  const itens = [];
  for (const itemId of todosIds) {
    const detalhe = await buscarDetalhePerformance(token, itemId);
    const info = infoAnuncios[itemId] || {};
    itens.push({
      itemId,
      titulo: info.titulo || itemId,
      link: info.link || null,
      status: unhealthyIds.includes(itemId) ? 'unhealthy' : 'warning',
      score: detalhe.score,
      level: detalhe.level,
      problemas: detalhe.problemas,
    });
    await aguardar(150); // throttle leve pra não estourar limite da API
  }

  itens.sort((a, b) => (a.status === b.status ? 0 : a.status === 'unhealthy' ? -1 : 1));

  const resultado = {
    atualizadoEm: new Date().toISOString(),
    totalUnhealthy: unhealthyIds.length,
    totalWarning: warningIds.length,
    itens,
  };
  await publicarDados('saude-anuncios.json', resultado);
  console.log(`Saúde dos anúncios publicada: ${unhealthyIds.length} perdendo exposição, ${warningIds.length} em alerta.`);

  // Só avisa por WhatsApp o que É NOVO na lista de "unhealthy" desde a
  // última execução — senão vira lembrete repetido todo dia pro mesmo item.
  const estadoAnterior = lerEstado();
  const idsNovos = unhealthyIds.filter((id) => !estadoAnterior.unhealthyIds.includes(id));
  fs.writeFileSync(ESTADO_PATH, JSON.stringify({ unhealthyIds }, null, 2));

  if (idsNovos.length > 0) {
    const itensNovos = itens.filter((i) => idsNovos.includes(i.itemId));
    await enviarNotificacao(formatarAlerta(itensNovos), `${idsNovos.length} anúncio(s) perdendo exposição no ML`);
    console.log(`Alerta enviado: ${idsNovos.length} anúncio(s) novo(s) perdendo exposição.`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Erro ao verificar saúde dos anúncios:', err.response?.data || err.message);
    process.exit(1);
  });
}
