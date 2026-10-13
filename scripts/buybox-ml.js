// scripts/buybox-ml.js
//
// Verifica, pra cada anúncio seu que participa de catálogo no Mercado Livre,
// se você está ganhando a "vitrine" (buy box) ou se um concorrente assumiu —
// e por qual preço. GET /products/{id}/items devolve todos os concorrentes
// já ordenados pelo algoritmo do próprio ML (o primeiro da lista é quem está
// ganhando); comparamos o seller_id de quem está em primeiro com o nosso.
//
// Roda 1x/dia (encadeado no workflow de lista de compras) — posição de buy
// box não muda de hora em hora o suficiente pra justificar checagem mais
// frequente, e evita gastar a cota de leitura da API à toa.

require('dotenv').config();
const axios = require('axios');
const { getMLAccessToken } = require('../lib/tokens');
const { enviarNotificacao } = require('../lib/notificar');
const { publicarDados, buscarDadosPublicados } = require('../lib/supabase-publicar');

const ML_SELLER_ID = String(process.env.ML_SELLER_ID);

function aguardar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buscarItensCatalogo(accessToken) {
  const itensCatalogo = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const resp = await axios.get(`https://api.mercadolibre.com/users/${ML_SELLER_ID}/items/search`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { offset, limit, status: 'active' },
    });
    const ids = resp.data.results || [];
    if (ids.length === 0) break;

    for (let i = 0; i < ids.length; i += 20) {
      const lote = ids.slice(i, i + 20);
      const detalhes = await axios.get('https://api.mercadolibre.com/items', {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { ids: lote.join(','), attributes: 'id,title,price,permalink,catalog_listing,catalog_product_id' },
      });

      for (const entry of detalhes.data) {
        const item = entry.body;
        if (entry.code === 200 && item.catalog_listing && item.catalog_product_id) {
          itensCatalogo.push({
            itemId: item.id,
            catalogProductId: item.catalog_product_id,
            titulo: item.title,
            preco: item.price,
            link: item.permalink,
          });
        }
      }
    }

    offset += limit;
  }

  return itensCatalogo;
}

async function verificarBuyBox(accessToken, itemCatalogo) {
  try {
    const resp = await axios.get(`https://api.mercadolibre.com/products/${itemCatalogo.catalogProductId}/items`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const concorrentes = resp.data.results || [];
    if (concorrentes.length === 0) return { ...itemCatalogo, ganhando: true, precoVencedor: null, totalConcorrentes: 0 };

    const vencedor = concorrentes[0];
    const ganhando = String(vencedor.seller_id) === ML_SELLER_ID;

    return {
      ...itemCatalogo,
      ganhando,
      precoVencedor: ganhando ? null : vencedor.price,
      totalConcorrentes: concorrentes.length,
    };
  } catch (err) {
    console.log(`Aviso: falha ao checar buy box do item ${itemCatalogo.itemId}: ${err.response?.status || err.message}`);
    return { ...itemCatalogo, ganhando: null, precoVencedor: null, totalConcorrentes: null };
  }
}

function formatarAlertaPerdas(itensNovos) {
  const LIMITE_ITENS = 15;
  const separador = '----------------------------';
  let corpo = `*VOCE PERDEU O BUY BOX*\n${itensNovos.length} anuncio(s) de catalogo com concorrente na frente\n`;
  for (const item of itensNovos.slice(0, LIMITE_ITENS)) {
    corpo += `\n${separador}\n*${item.titulo}*\nSeu preco: R$ ${item.preco}\nPreco do vencedor: R$ ${item.precoVencedor}\n`;
  }
  if (itensNovos.length > LIMITE_ITENS) {
    corpo += `\n${separador}\n... e mais ${itensNovos.length - LIMITE_ITENS} anuncio(s). Veja todos no painel (Medidas > Buy Box).`;
  }
  return corpo;
}

async function main() {
  const token = await getMLAccessToken();
  const itensCatalogo = await buscarItensCatalogo(token);

  const resultados = [];
  for (const item of itensCatalogo) {
    resultados.push(await verificarBuyBox(token, item));
    await aguardar(150); // throttle leve pra não estourar limite da API
  }

  const perdendo = resultados.filter((r) => r.ganhando === false);

  // Só avisa quem É NOVO na lista de "perdendo" desde a última execução —
  // senão vira lembrete repetido todo dia do mesmo item (igual ao vigia).
  const estadoAnterior = (await buscarDadosPublicados('buybox-estado.json')) || { perdendoIds: [] };
  const idsPerdendoAgora = perdendo.map((r) => r.itemId);
  const idsNovos = idsPerdendoAgora.filter((id) => !estadoAnterior.perdendoIds.includes(id));
  await publicarDados('buybox-estado.json', { perdendoIds: idsPerdendoAgora });

  if (idsNovos.length > 0) {
    const itensNovos = perdendo.filter((r) => idsNovos.includes(r.itemId));
    await enviarNotificacao(formatarAlertaPerdas(itensNovos), `Buy box: ${idsNovos.length} anúncio(s) perdido(s)`);
    console.log(`Alerta enviado: ${idsNovos.length} anúncio(s) perderam o buy box.`);
  }

  const resultado = {
    atualizadoEm: new Date().toISOString(),
    totalCatalogo: resultados.length,
    totalPerdendo: perdendo.length,
    itens: resultados,
  };
  await publicarDados('buybox-ml.json', resultado);
  console.log(`Buy box publicado: ${resultados.length} anúncio(s) de catálogo, ${perdendo.length} perdendo a vitrine.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Erro ao verificar buy box:', err.response?.data || err.message);
    process.exit(1);
  });
}
