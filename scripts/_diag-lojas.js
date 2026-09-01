// scripts/_diag-lojas.js
//
// Diagnóstico ÚNICO E TEMPORÁRIO: lista as lojas/canais distintos que
// aparecem nos pedidos de venda recentes do Bling, pra descobrir o ID da
// loja da Bagy (e confirmar o da loja física) antes de filtrar a Lista de
// Compras pra só e-commerce. Apaga esse arquivo e o workflow depois de usar.

require('dotenv').config();
const { getBlingAccessToken } = require('../lib/tokens');
const { blingGet } = require('../lib/bling-http');

async function main() {
  const token = await getBlingAccessToken();

  const hoje = new Date();
  const dataInicial = new Date(hoje.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dataFinal = hoje.toISOString().slice(0, 10);

  const resp = await blingGet('https://api.bling.com.br/Api/v3/pedidos/vendas', {
    headers: { Authorization: `Bearer ${token}` },
    params: { pagina: 1, limite: 100, dataInicial, dataFinal },
  });

  const dados = resp.data.data || [];
  console.log(`${dados.length} pedido(s) na amostra.`);
  console.log('Exemplo de pedido completo (primeiro da lista):');
  console.log(JSON.stringify(dados[0], null, 2));

  const porLoja = {};
  for (const p of dados) {
    const id = p.loja?.id ?? 'sem-loja-na-listagem';
    porLoja[id] = (porLoja[id] || 0) + 1;
  }
  console.log('\nContagem por loja.id (na listagem, se disponível):');
  console.log(JSON.stringify(porLoja, null, 2));
}

main().catch((err) => {
  console.error('Erro no diagnóstico:', err.response?.data || err.message);
  process.exit(1);
});
