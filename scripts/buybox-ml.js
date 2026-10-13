// scripts/buybox-ml.js
//
// DIAGNOSTICO temporario: confirma o formato real da API de catalogo antes
// de montar a logica de verdade (ja fomos pegos uma vez adivinhando nome de
// campo errado em medidas-ml.js).

require('dotenv').config();
const axios = require('axios');
const { getMLAccessToken } = require('../lib/tokens');

const ML_SELLER_ID = process.env.ML_SELLER_ID;

async function main() {
  const token = await getMLAccessToken();

  let offset = 0;
  const limit = 50;
  let itemCatalogo = null;

  while (!itemCatalogo) {
    const resp = await axios.get(`https://api.mercadolibre.com/users/${ML_SELLER_ID}/items/search`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { offset, limit, status: 'active' },
    });
    const ids = resp.data.results || [];
    if (ids.length === 0) break;

    for (let i = 0; i < ids.length && !itemCatalogo; i += 20) {
      const lote = ids.slice(i, i + 20);
      const detalhes = await axios.get('https://api.mercadolibre.com/items', {
        headers: { Authorization: `Bearer ${token}` },
        params: { ids: lote.join(','), attributes: 'id,title,price,catalog_listing,catalog_product_id' },
      });

      for (const entry of detalhes.data) {
        if (entry.body?.catalog_listing) {
          itemCatalogo = entry.body;
          break;
        }
      }
    }
    offset += limit;
  }

  if (!itemCatalogo) {
    console.log('Nenhum item catalog_listing=true encontrado.');
    return;
  }

  console.log('Item catálogo encontrado:', JSON.stringify(itemCatalogo));

  if (itemCatalogo.catalog_product_id) {
    const respComAttr = await axios.get(`https://api.mercadolibre.com/products/${itemCatalogo.catalog_product_id}`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { attributes: 'buy_box_winner,buy_box_winner_price_range' },
    });
    console.log('DIAGNOSTICO com attributes=buy_box_winner:', JSON.stringify({
      buy_box_winner: respComAttr.data.buy_box_winner,
      buy_box_winner_price_range: respComAttr.data.buy_box_winner_price_range,
    }));

    try {
      const respItems = await axios.get(`https://api.mercadolibre.com/products/${itemCatalogo.catalog_product_id}/items`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      console.log('DIAGNOSTICO /products/{id}/items:', JSON.stringify(respItems.data).slice(0, 2000));
    } catch (err) {
      console.log('DIAGNOSTICO /products/{id}/items falhou:', err.response?.status, JSON.stringify(err.response?.data));
    }
  }
}

main().catch((err) => {
  console.error('Erro no diagnóstico de buy box:', err.response?.data || err.message);
  process.exit(1);
});
