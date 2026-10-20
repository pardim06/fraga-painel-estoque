// DIAGNOSTICO temporario — confirma formato real da API do Bling antes de
// montar o painel comercial (nome das lojas por ID, e se o pedido já vem
// com os itens/categoria ou precisa de uma chamada de detalhe por pedido).
require('dotenv').config();
const { getBlingAccessToken } = require('../lib/tokens');
const { blingGet } = require('../lib/bling-http');

async function main() {
  const token = await getBlingAccessToken();

  const inicioMes = new Date();
  inicioMes.setDate(1);
  const dataInicial = inicioMes.toISOString().slice(0, 10);
  const dataFinal = new Date().toISOString().slice(0, 10);

  const respPedidos = await blingGet('https://api.bling.com.br/Api/v3/pedidos/vendas', {
    headers: { Authorization: `Bearer ${token}` },
    params: { pagina: 1, limite: 100, dataInicial, dataFinal },
  });
  const pedidos = respPedidos.data.data || [];
  console.log(`DIAGNOSTICO total pedidos na pagina: ${pedidos.length}`);

  const idsAlvo = ['204966737', '205655926'];
  for (const idLoja of idsAlvo) {
    const exemplo = pedidos.find((p) => String(p.loja?.id) === idLoja);
    console.log(`DIAGNOSTICO pedido loja ${idLoja}:`, JSON.stringify(exemplo));
  }

  const primeiroComId = pedidos.find((p) => p.id);
  if (primeiroComId?.id) {
    const respDetalhe = await blingGet(`https://api.bling.com.br/Api/v3/pedidos/vendas/${primeiroComId.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log('DIAGNOSTICO pedido (detalhe completo):', JSON.stringify(respDetalhe.data).slice(0, 4000));
  }
}

main().catch((err) => {
  console.error('Erro no diagnóstico:', err.response?.data || err.message);
  process.exit(1);
});
