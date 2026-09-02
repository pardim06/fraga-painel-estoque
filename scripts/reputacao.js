// scripts/reputacao.js
//
// Busca o "termômetro" de reputação do vendedor no Mercado Livre — nível,
// status de power seller, e as taxas de cancelamento/reclamação/atraso dos
// últimos 60 dias. Roda junto com o verificador de perguntas (mesma
// cadência, é só 1 chamada leve à API).

require('dotenv').config();
const axios = require('axios');
const { getMLAccessToken } = require('../lib/tokens');
const { publicarDados } = require('../lib/supabase-publicar');

async function main() {
  const token = await getMLAccessToken();
  const sellerId = process.env.ML_SELLER_ID;

  const resp = await axios.get(`https://api.mercadolibre.com/users/${sellerId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const { nickname, seller_reputation } = resp.data;

  const resultado = {
    atualizadoEm: new Date().toISOString(),
    nickname,
    nivel: seller_reputation?.level_id || null,
    powerSeller: seller_reputation?.power_seller_status || null,
    metricas: {
      vendas60d: seller_reputation?.metrics?.sales?.completed ?? null,
      cancelamento: {
        taxa: seller_reputation?.metrics?.cancellations?.rate ?? null,
        quantidade: seller_reputation?.metrics?.cancellations?.value ?? null,
      },
      reclamacao: {
        taxa: seller_reputation?.metrics?.claims?.rate ?? null,
        quantidade: seller_reputation?.metrics?.claims?.value ?? null,
      },
      atraso: {
        taxa: seller_reputation?.metrics?.delayed_handling_time?.rate ?? null,
        quantidade: seller_reputation?.metrics?.delayed_handling_time?.value ?? null,
      },
    },
  };

  await publicarDados('reputacao-ml.json', resultado);
  console.log(`Reputação publicada (nível ${resultado.nivel}, ${resultado.metricas.cancelamento.quantidade} cancelamento(s) em 60d).`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Erro ao buscar reputação:', err.response?.data || err.message);
    process.exit(1);
  });
}
