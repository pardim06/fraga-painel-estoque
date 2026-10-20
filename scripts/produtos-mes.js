// scripts/produtos-mes.js
//
// Produtos mais vendidos do mês (ML + Bagy, via Bling) — diferente do
// faturamento "ao vivo" (lib/faturamento-live.js, a cada 5min), isso
// precisa abrir o DETALHE de cada pedido pra pegar os itens (a listagem
// não traz), então é caro demais pra rodar com essa frequência. Roda 1x/dia
// (encadeado no workflow de lista de compras).

require('dotenv').config();
const { getBlingAccessToken } = require('../lib/tokens');
const { blingGet } = require('../lib/bling-http');
const { publicarDados } = require('../lib/supabase-publicar');
const { LOJAS_ECOMMERCE } = require('../lib/lojas-ecommerce');

const SITUACAO_CANCELADO = 12;
const TOP_N = 10;

async function buscarPedidosDoMes(blingToken) {
  const inicioMes = new Date();
  inicioMes.setDate(1);
  inicioMes.setHours(0, 0, 0, 0);
  const dataInicial = inicioMes.toISOString().slice(0, 10);
  const dataFinal = new Date().toISOString().slice(0, 10);

  const pedidos = [];
  let pagina = 1;

  while (true) {
    const resp = await blingGet('https://api.bling.com.br/Api/v3/pedidos/vendas', {
      headers: { Authorization: `Bearer ${blingToken}` },
      params: { pagina, limite: 100, dataInicial, dataFinal },
    });

    const dados = resp.data.data || [];
    if (dados.length === 0) break;

    for (const p of dados) {
      if (p.situacao?.id === SITUACAO_CANCELADO) continue;
      if (!LOJAS_ECOMMERCE.has(String(p.loja?.id))) continue;
      pedidos.push(p);
    }

    if (dados.length < 100) break;
    pagina++;
  }

  return { pedidos, mesAtual: inicioMes.toISOString().slice(0, 7) };
}

async function agregarProdutos(blingToken, pedidos) {
  const porSku = {};
  let pedidosComErro = 0;

  for (const p of pedidos) {
    try {
      const resp = await blingGet(`https://api.bling.com.br/Api/v3/pedidos/vendas/${p.id}`, {
        headers: { Authorization: `Bearer ${blingToken}` },
      });
      const itens = resp.data.data?.itens || [];

      for (const item of itens) {
        const sku = item.codigo || `produto-${item.produto?.id}`;
        if (!porSku[sku]) {
          porSku[sku] = { sku, nome: item.descricao, quantidade: 0, faturamento: 0 };
        }
        porSku[sku].quantidade += item.quantidade || 0;
        porSku[sku].faturamento += (item.valor || 0) * (item.quantidade || 0);
      }
    } catch {
      pedidosComErro++;
    }
  }

  if (pedidosComErro > 0) {
    console.log(`Aviso: ${pedidosComErro} pedido(s) falharam ao buscar detalhe (ignorados no total de produtos).`);
  }

  return Object.values(porSku);
}

async function main() {
  const blingToken = await getBlingAccessToken();
  const { pedidos, mesAtual } = await buscarPedidosDoMes(blingToken);
  const produtos = await agregarProdutos(blingToken, pedidos);

  produtos.sort((a, b) => b.faturamento - a.faturamento);
  const top = produtos.slice(0, TOP_N).map((p) => ({
    ...p,
    faturamento: Math.round(p.faturamento * 100) / 100,
  }));

  const resultado = {
    atualizadoEm: new Date().toISOString(),
    mesAtual,
    totalProdutosDistintos: produtos.length,
    principaisProdutos: top,
  };

  await publicarDados('produtos-mes.json', resultado);
  console.log(`Produtos do mês publicados: ${produtos.length} produto(s) distinto(s), top ${top.length} salvos.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Erro ao agregar produtos do mês:', err.response?.data || err.message);
    process.exit(1);
  });
}
