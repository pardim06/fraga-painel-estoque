// DIAGNOSTICO temporario — confirma formato real da API do Bling antes de
// montar o painel comercial (nome das lojas por ID, e se o pedido já vem
// com os itens/categoria ou precisa de uma chamada de detalhe por pedido).
require('dotenv').config();
const { getBlingAccessToken } = require('../lib/tokens');
const { blingGet } = require('../lib/bling-http');

async function main() {
  const token = await getBlingAccessToken();

  const respLojas = await blingGet('https://api.bling.com.br/Api/v3/lojas', {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log('DIAGNOSTICO lojas:', JSON.stringify(respLojas.data));

  const inicioMes = new Date();
  inicioMes.setDate(1);
  const dataInicial = inicioMes.toISOString().slice(0, 10);
  const dataFinal = new Date().toISOString().slice(0, 10);

  const respPedidos = await blingGet('https://api.bling.com.br/Api/v3/pedidos/vendas', {
    headers: { Authorization: `Bearer ${token}` },
    params: { pagina: 1, limite: 1, dataInicial, dataFinal },
  });
  const pedido = respPedidos.data.data?.[0];
  console.log('DIAGNOSTICO pedido (listagem):', JSON.stringify(pedido));

  if (pedido?.id) {
    const respDetalhe = await blingGet(`https://api.bling.com.br/Api/v3/pedidos/vendas/${pedido.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log('DIAGNOSTICO pedido (detalhe):', JSON.stringify(respDetalhe.data).slice(0, 3000));
  }
}

main().catch((err) => {
  console.error('Erro no diagnóstico:', err.response?.data || err.message);
  process.exit(1);
});
