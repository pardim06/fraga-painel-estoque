// scripts/mercadolider.js
//
// Calcula o quanto falta pra bater os requisitos do MercadoLíder Platinum.
// O Mercado Livre não expõe esses requisitos via API — foram pesquisados
// externamente (ver conversa/fontes) e podem mudar com o tempo; vale
// conferir de vez em quando em Reputação > MercadoLíder no painel do
// vendedor pra confirmar que os números aqui ainda batem.
//
// Roda 1x/dia (encadeado no workflow de lista de compras, junto do saúde
// dos anúncios) — o cálculo de faturamento varre todos os pedidos pagos
// dos últimos 60 dias, não faz sentido rodar a cada 5min.

require('dotenv').config();
const axios = require('axios');
const { getMLAccessToken } = require('../lib/tokens');
const { publicarDados, buscarDadosPublicados } = require('../lib/supabase-publicar');

const META = {
  vendas60d: 1725,
  faturamento60d: 296000,
  cancelamentoMax: 0.005,
  reclamacaoMax: 0.01,
  atrasoMax: 0.06,
};

// Um único pente de 60 dias já cobre o mês corrente inteiro (mês tem no
// máximo 31 dias) — separa o total do mês sem precisar de uma segunda
// varredura na API.
async function buscarFaturamento(token, sellerId) {
  const de = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const ate = new Date().toISOString();
  const inicioMes = new Date();
  inicioMes.setDate(1);
  inicioMes.setHours(0, 0, 0, 0);

  let total60d = 0;
  let qtd60d = 0;
  let totalMes = 0;
  let qtdMes = 0;
  let offset = 0;
  const limit = 50;

  while (true) {
    const resp = await axios.get('https://api.mercadolibre.com/orders/search', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        seller: sellerId,
        'order.status': 'paid',
        'order.date_created.from': de,
        'order.date_created.to': ate,
        limit,
        offset,
      },
    });

    for (const pedido of resp.data.results) {
      total60d += pedido.total_amount || 0;
      qtd60d++;
      if (new Date(pedido.date_created) >= inicioMes) {
        totalMes += pedido.total_amount || 0;
        qtdMes++;
      }
    }

    offset += limit;
    if (offset >= resp.data.paging.total || resp.data.results.length === 0) break;
  }

  return { total60d, qtd60d, totalMes, qtdMes, mesAtual: inicioMes.toISOString().slice(0, 7) };
}

async function main() {
  const token = await getMLAccessToken();
  const sellerId = process.env.ML_SELLER_ID;

  const { total60d: faturamento60d, qtd60d: pedidosPagos, totalMes, qtdMes, mesAtual } = await buscarFaturamento(token, sellerId);
  const reputacao = await buscarDadosPublicados('reputacao-ml.json');
  const m = reputacao?.metricas || {};
  const vendas60d = m.vendas60d ?? pedidosPagos;

  const requisitos = [
    {
      chave: 'vendas',
      titulo: 'Vendas (60 dias)',
      atual: vendas60d,
      meta: META.vendas60d,
      tipo: 'contagem',
      cumprido: vendas60d >= META.vendas60d,
    },
    {
      chave: 'faturamento',
      titulo: 'Faturamento (60 dias)',
      atual: faturamento60d,
      meta: META.faturamento60d,
      tipo: 'moeda',
      cumprido: faturamento60d >= META.faturamento60d,
    },
    {
      chave: 'cancelamento',
      titulo: 'Taxa de cancelamento (vendedor)',
      atual: m.cancelamento?.taxa ?? null,
      meta: META.cancelamentoMax,
      tipo: 'taxa_max',
      cumprido: (m.cancelamento?.taxa ?? 1) <= META.cancelamentoMax,
    },
    {
      chave: 'reclamacao',
      titulo: 'Taxa de reclamação',
      atual: m.reclamacao?.taxa ?? null,
      meta: META.reclamacaoMax,
      tipo: 'taxa_max',
      cumprido: (m.reclamacao?.taxa ?? 1) <= META.reclamacaoMax,
    },
    {
      chave: 'atraso',
      titulo: 'Taxa de atraso no envio',
      atual: m.atraso?.taxa ?? null,
      meta: META.atrasoMax,
      tipo: 'taxa_max',
      cumprido: (m.atraso?.taxa ?? 1) <= META.atrasoMax,
    },
    {
      chave: 'termometro',
      titulo: 'Termômetro verde-escuro',
      atual: reputacao?.nivel ?? null,
      meta: '5_green',
      tipo: 'nivel',
      cumprido: reputacao?.nivel === '5_green',
    },
  ];

  const faltantes = requisitos.filter((r) => !r.cumprido);

  const resultado = {
    atualizadoEm: new Date().toISOString(),
    powerSellerAtual: reputacao?.powerSeller || null,
    faturamentoMesAtual: { mes: mesAtual, total: totalMes, quantidade: qtdMes },
    requisitos,
    totalRequisitos: requisitos.length,
    totalFaltantes: faltantes.length,
    observacao:
      'Requisitos de MercadoLíder Platinum pesquisados externamente (o Mercado Livre não documenta isso via API) — confira também em Reputação > MercadoLíder no seu painel de vendedor, os valores podem mudar com o tempo. Não inclui requisitos não numéricos (documentação validada, loja ativa há 4+ meses).',
  };

  await publicarDados('mercadolider-platinum.json', resultado);
  console.log(
    `MercadoLíder Platinum: ${requisitos.length - faltantes.length}/${requisitos.length} requisitos cumpridos. Faturamento 60d: R$ ${faturamento60d.toFixed(2)} (${pedidosPagos} pedidos pagos).`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Erro ao calcular progresso pro MercadoLíder Platinum:', err.response?.data || err.message);
    process.exit(1);
  });
}
