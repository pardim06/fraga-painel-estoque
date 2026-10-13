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
    const respProduto = await axios.get(`https://api.mercadolibre.com/products/${itemCatalogo.catalog_product_id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log('DIAGNOSTICO produto catálogo completo:', JSON.stringify(respProduto.data));
  }
}

main().catch((err) => {
  console.error('Erro no diagnóstico de buy box:', err.response?.data || err.message);
  process.exit(1);
});
