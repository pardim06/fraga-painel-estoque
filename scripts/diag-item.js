require('dotenv').config();
const axios = require('axios');
const { getMLAccessToken } = require('../lib/tokens');

async function main() {
  const token = await getMLAccessToken();
  const resp = await axios.get('https://api.mercadolibre.com/items/MLB7876715054', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const item = resp.data;
  console.log('DIAGNOSTICO item:', JSON.stringify({
    id: item.id,
    status: item.status,
    sub_status: item.sub_status,
    health: item.health,
    tags: item.tags,
    deal_ids: item.deal_ids,
    catalog_listing: item.catalog_listing,
    listing_type_id: item.listing_type_id,
    variations: item.variations?.length,
    shipping_logistic_type: item.shipping?.logistic_type,
    shipping_mode: item.shipping?.mode,
  }));
}

main().catch((err) => {
  console.error('Erro no diagnóstico do item:', err.response?.data || err.message);
  process.exit(1);
});
