// lib/faturamento-live.js
//
// Dado "ao vivo" do painel comercial — faturamento do mês, pedidos, ticket
// médio, por canal, série diária e últimas vendas. Chamado de dentro do
// verificador de estoque (a cada 5min) pra reaproveitar o blingToken que já
// foi buscado ali, sem gastar uma rotação de token extra só pra isso.
//
// "Top produtos do mês" e "desempenho por categoria" NÃO estão aqui —
// precisam do detalhe de cada pedido (itens), que é uma chamada por pedido;
// rodar isso a cada 5min pro mês inteiro ficaria caro demais. Isso fica no
// job diário (scripts/produtos-mes.js).

const { blingGet } = require('./bling-http');
const { publicarDados } = require('./supabase-publicar');
const { LOJAS_ECOMMERCE, CANAL_POR_LOJA } = require('./lojas-ecommerce');

const SITUACAO_CANCELADO = 12;
const QTD_ULTIMAS_VENDAS = 12;

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

function agregarPorCanalEDia(pedidos) {
  const porCanal = {};
  const porDia = {};

  for (const p of pedidos) {
    const canal = CANAL_POR_LOJA[p.loja?.id] || `Loja ${p.loja?.id}`;
    const dia = p.data; // já vem "YYYY-MM-DD"
    const valor = p.total || 0;

    if (!porCanal[canal]) porCanal[canal] = { total: 0, quantidade: 0 };
    porCanal[canal].total += valor;
    porCanal[canal].quantidade++;

    if (!porDia[dia]) porDia[dia] = { total: 0, quantidade: 0 };
    porDia[dia].total += valor;
    porDia[dia].quantidade++;
  }

  return { porCanal, porDia };
}

// Só os N pedidos mais recentes — pra mostrar o nome do produto no feed
// "últimas vendas" precisa do detalhe (a listagem não traz itens), mas
// isso é barato por ser um número fixo e pequeno, não o mês inteiro.
async function buscarUltimasVendas(blingToken, pedidos) {
  const recentes = [...pedidos]
    .sort((a, b) => (b.id || 0) - (a.id || 0))
    .slice(0, QTD_ULTIMAS_VENDAS);

  const resultado = [];
  for (const p of recentes) {
    try {
      const resp = await blingGet(`https://api.bling.com.br/Api/v3/pedidos/vendas/${p.id}`, {
        headers: { Authorization: `Bearer ${blingToken}` },
      });
      const itens = resp.data.data?.itens || [];
      const produto = itens[0]?.descricao || null;
      const maisItens = itens.length > 1 ? ` (+${itens.length - 1} item(ns))` : '';

      resultado.push({
        pedidoId: p.id,
        canal: CANAL_POR_LOJA[p.loja?.id] || `Loja ${p.loja?.id}`,
        produto: produto ? produto + maisItens : null,
        valor: p.total || 0,
        data: p.data,
      });
    } catch {
      resultado.push({
        pedidoId: p.id,
        canal: CANAL_POR_LOJA[p.loja?.id] || `Loja ${p.loja?.id}`,
        produto: null,
        valor: p.total || 0,
        data: p.data,
      });
    }
  }

  return resultado;
}

async function publicarFaturamentoLive(blingToken, estoqueBling) {
  const { pedidos, mesAtual } = await buscarPedidosDoMes(blingToken);
  const { porCanal, porDia } = agregarPorCanalEDia(pedidos);
  const ultimasVendas = await buscarUltimasVendas(blingToken, pedidos);

  const total = pedidos.reduce((s, p) => s + (p.total || 0), 0);
  const quantidade = pedidos.length;
  const estoqueDisponivel = Object.values(estoqueBling).reduce((s, i) => s + (i.saldo || 0), 0);

  const resultado = {
    atualizadoEm: new Date().toISOString(),
    mesAtual,
    faturamentoTotal: Math.round(total * 100) / 100,
    pedidos: quantidade,
    ticketMedio: quantidade > 0 ? Math.round((total / quantidade) * 100) / 100 : 0,
    estoqueDisponivel,
    porCanal,
    porDia,
    ultimasVendas,
  };

  await publicarDados('painel-comercial.json', resultado);
  console.log(`Painel comercial: R$ ${total.toFixed(2)} em ${quantidade} pedido(s) no mês.`);
}

module.exports = { publicarFaturamentoLive };
