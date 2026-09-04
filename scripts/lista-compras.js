// scripts/lista-compras.js
//
// Gera a lista de reposição automática: cruza o estoque atual do Bling com a
// velocidade real de saída (últimos 90 dias, comparado com os últimos 30) e
// sugere o que comprar antes de faltar, já classificado por curva ABC
// (faturamento). Roda 1x/dia — é uma consulta pesada (milhares de pedidos) e
// não precisa de tempo real como o verificador de estoque.
//
// PREMISSAS (documentadas aqui de propósito — revise se algo não bater):
// - Considera só pedidos de canais de e-commerce (ML + Bagy/site) — loja
//   física fica de fora de propósito, porque o estoque considerado aqui é
//   só o do depósito "SITE / MERCADO LIVRE" (não o da loja física), e
//   contar a saída da loja física infla a velocidade sem ter relação com
//   esse depósito. IDs de loja identificados por inferência (loja física
//   sempre tem "vendedor" no pedido, e-commerce nunca tem) — confira em
//   Vendas > Pedidos no Bling se algum dia os números não baterem.
// - Ignora pedidos com situação "Cancelado" (id 12, padrão do sistema Bling).
//   Se sua conta usa um fluxo de situações diferente, ajuste SITUACAO_CANCELADO.
// - Estoque atual = saldo do depósito "SITE / MERCADO LIVRE" (mesmo usado no
//   verificador de estoque), não o estoque total da empresa.
// - Produtos "pai" com variação (formato V) são ignorados — quem entra na
//   conta são as variações filhas, que têm SKU e estoque próprios.

require('dotenv').config();
const { getBlingAccessToken } = require('../lib/tokens');
const { blingGet, aguardar } = require('../lib/bling-http');
const { publicarDados } = require('../lib/supabase-publicar');
const { LOJAS_ECOMMERCE } = require('../lib/lojas-ecommerce');
const BLING_DEPOSITO_ID = process.env.BLING_DEPOSITO_ID || '14887750294';

const SITUACAO_CANCELADO = 12;

const JANELA_DIAS = 90;
const JANELA_RECENTE_DIAS = 30;
const LEAD_TIME_DIAS = Number(process.env.LEAD_TIME_DIAS || 7);
const SEGURANCA_DIAS = Number(process.env.SEGURANCA_DIAS || 15);
const COBERTURA_ALVO_DIAS = LEAD_TIME_DIAS + SEGURANCA_DIAS;

// ===== 1. PRODUTOS ATIVOS (Bling) =====
// { id -> { codigo, nome, precoCusto } } — só formato "S" (simples) e "E"
// (kit), que têm saldo próprio. Formato "V" (pai) fica de fora.
async function getProdutosAtivos(token) {
  const produtos = {};
  let pagina = 1;

  while (true) {
    const resp = await blingGet('https://api.bling.com.br/Api/v3/produtos', {
      headers: { Authorization: `Bearer ${token}` },
      params: { pagina, limite: 100, situacao: 'A' },
    });

    const dados = resp.data.data || [];
    if (dados.length === 0) break;

    for (const item of dados) {
      if (item.codigo && item.formato !== 'V') {
        produtos[item.id] = { codigo: item.codigo, nome: item.nome, precoCusto: item.precoCusto || 0 };
      }
    }

    pagina++;
  }

  return produtos;
}

// ===== 2. ESTOQUE ATUAL (depósito SITE/ML) =====
// { codigo -> saldoAtual }
async function getEstoqueAtual(token, produtos) {
  const estoque = {};
  const ids = Object.keys(produtos);
  const TAMANHO_LOTE = 50;

  for (let i = 0; i < ids.length; i += TAMANHO_LOTE) {
    const lote = ids.slice(i, i + TAMANHO_LOTE);
    const resp = await blingGet('https://api.bling.com.br/Api/v3/estoques/saldos', {
      headers: { Authorization: `Bearer ${token}` },
      params: { idsProdutos: lote },
    });

    for (const item of resp.data.data || []) {
      const codigo = produtos[item.produto?.id]?.codigo;
      const depositoSite = item.depositos?.find((d) => String(d.id) === String(BLING_DEPOSITO_ID));
      const saldo = depositoSite?.saldoVirtual ?? depositoSite?.saldoFisico;
      if (codigo && saldo !== undefined) estoque[codigo] = saldo;
    }
  }

  return estoque;
}

// ===== 3. PEDIDOS DE VENDA — SÓ CANAIS DE E-COMMERCE (últimos 90 dias) =====
async function getPedidosVendas(token) {
  const hoje = new Date();
  const dataInicial = new Date(hoje.getTime() - JANELA_DIAS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dataFinal = hoje.toISOString().slice(0, 10);

  const pedidos = [];
  let pagina = 1;

  while (true) {
    const resp = await blingGet('https://api.bling.com.br/Api/v3/pedidos/vendas', {
      headers: { Authorization: `Bearer ${token}` },
      params: { pagina, limite: 100, dataInicial, dataFinal },
    });

    const dados = resp.data.data || [];
    if (dados.length === 0) break;

    for (const p of dados) {
      if (p.situacao?.id === SITUACAO_CANCELADO) continue;
      if (!LOJAS_ECOMMERCE.has(String(p.loja?.id))) continue;
      pedidos.push({ id: p.id, data: p.data });
    }

    if (dados.length < 100) break;
    pagina++;
  }

  return pedidos;
}

// ===== 4. VENDA POR SKU (busca o detalhe de cada pedido pra pegar os itens) =====
// { codigo -> { qtd90, qtd30, receita90 } }
async function getVendasPorSku(token, pedidos) {
  const vendas = {};
  const agora = Date.now();
  const limite30 = agora - JANELA_RECENTE_DIAS * 24 * 60 * 60 * 1000;

  let processados = 0;
  for (const pedido of pedidos) {
    let detalhe;
    try {
      const resp = await blingGet(`https://api.bling.com.br/Api/v3/pedidos/vendas/${pedido.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      detalhe = resp.data.data;
    } catch (err) {
      console.log(`Aviso: falha ao buscar pedido ${pedido.id}, pulando (${err.response?.status || err.message}).`);
      continue;
    }

    const dataPedido = new Date(pedido.data).getTime();
    const dentroDe30 = dataPedido >= limite30;

    for (const item of detalhe.itens || []) {
      const codigo = item.codigo;
      if (!codigo) continue;

      if (!vendas[codigo]) vendas[codigo] = { qtd90: 0, qtd30: 0, receita90: 0 };
      vendas[codigo].qtd90 += item.quantidade;
      vendas[codigo].receita90 += item.quantidade * item.valor;
      if (dentroDe30) vendas[codigo].qtd30 += item.quantidade;
    }

    processados++;
    if (processados % 200 === 0) {
      console.log(`Progresso: ${processados}/${pedidos.length} pedidos processados...`);
    }
  }

  return vendas;
}

// ===== 5. CURVA ABC (por faturamento) =====
function classificarABC(itens) {
  const comReceita = itens.filter((i) => i.faturamento90d > 0).sort((a, b) => b.faturamento90d - a.faturamento90d);
  const totalReceita = comReceita.reduce((soma, i) => soma + i.faturamento90d, 0);

  let acumulado = 0;
  for (const item of comReceita) {
    acumulado += item.faturamento90d;
    const percentualAcumulado = totalReceita > 0 ? acumulado / totalReceita : 0;
    item.classeABC = percentualAcumulado <= 0.8 ? 'A' : percentualAcumulado <= 0.95 ? 'B' : 'C';
  }

  // produtos sem venda no período não entram na curva (não têm faturamento pra classificar)
  for (const item of itens) {
    if (!item.classeABC) item.classeABC = '—';
  }
}

// ===== 5b. URGÊNCIA DO PEDIDO (dias até faltar x lead time do fornecedor) =====
// A pergunta que importa pro dono comprar na hora certa não é só "quantos
// dias de estoque restam", é "ainda dá tempo do fornecedor entregar antes de
// faltar". Se o estoque acaba antes do lead time, o pedido já está atrasado
// mesmo que você feche ele hoje.
function calcularUrgencia(diasDeEstoqueRestante) {
  if (diasDeEstoqueRestante === null) {
    return { urgencia: 'sem_dado', mensagemUrgencia: 'Sem venda no período pra estimar quando vai faltar.' };
  }

  const dias = Math.round(diasDeEstoqueRestante * 10) / 10;

  // Estoque zerado/negativo (saldo <= 0, já vendendo sem ter) é um caso à
  // parte — "acaba em -105 dias" não faz sentido pra quem lê.
  if (dias <= 0) {
    const diasAtraso = Math.ceil(LEAD_TIME_DIAS - dias);
    return {
      urgencia: 'atrasado',
      mensagemUrgencia: `Estoque já está zerado ou negativo. Fornecedor demora ${LEAD_TIME_DIAS} dia(s) — pedido está atrasado em ${diasAtraso} dia(s).`,
    };
  }

  if (dias <= LEAD_TIME_DIAS) {
    const diasAtraso = Math.ceil(LEAD_TIME_DIAS - dias);
    return {
      urgencia: 'atrasado',
      mensagemUrgencia: `Estoque acaba em ${dias} dia(s), mas o fornecedor demora ${LEAD_TIME_DIAS} dia(s) pra entregar — pedido já está atrasado em ${diasAtraso} dia(s).`,
    };
  }

  if (dias <= COBERTURA_ALVO_DIAS) {
    const diasParaPedir = Math.floor(dias - LEAD_TIME_DIAS);
    return {
      urgencia: 'comprar',
      mensagemUrgencia: `Estoque acaba em ${dias} dia(s). Fornecedor demora ${LEAD_TIME_DIAS} dia(s) — faça o pedido em até ${diasParaPedir} dia(s) pra não faltar.`,
    };
  }

  return {
    urgencia: 'ok',
    mensagemUrgencia: `Estoque cobre ${dias} dia(s), acima da cobertura alvo de ${COBERTURA_ALVO_DIAS} dia(s).`,
  };
}

// ===== 6. MONTAGEM DA LISTA =====
function montarLista(produtos, estoqueAtual, vendas) {
  const itens = Object.values(produtos).map(({ codigo, nome, precoCusto }) => {
    const estoque = estoqueAtual[codigo] ?? 0;
    const v = vendas[codigo] || { qtd90: 0, qtd30: 0, receita90: 0 };

    const velocidade90 = v.qtd90 / JANELA_DIAS;
    const velocidade30 = v.qtd30 / JANELA_RECENTE_DIAS;
    // usa a maior das duas — subestimar velocidade é o erro mais caro aqui
    // (gera furo); superestimar só sobra estoque.
    const velocidadeConsiderada = Math.max(velocidade90, velocidade30);

    let tendencia = 'estável';
    if (velocidade90 > 0) {
      if (velocidade30 > velocidade90 * 1.3) tendencia = 'subindo';
      else if (velocidade30 < velocidade90 * 0.7) tendencia = 'caindo';
    } else if (velocidade30 > 0) {
      tendencia = 'subindo'; // vendas novas, sem histórico prévio
    }

    const diasDeEstoqueRestante = velocidadeConsiderada > 0 ? estoque / velocidadeConsiderada : null;
    const precisaComprar = diasDeEstoqueRestante !== null && diasDeEstoqueRestante <= COBERTURA_ALVO_DIAS;
    const quantidadeSugerida = precisaComprar
      ? Math.max(0, Math.ceil(velocidadeConsiderada * COBERTURA_ALVO_DIAS - estoque))
      : 0;

    const { urgencia, mensagemUrgencia } = calcularUrgencia(diasDeEstoqueRestante);

    return {
      sku: codigo,
      nome,
      estoqueAtual: estoque,
      vendidoUlt90d: v.qtd90,
      vendidoUlt30d: v.qtd30,
      velocidadeDiaria: Math.round(velocidadeConsiderada * 100) / 100,
      tendencia,
      diasDeEstoqueRestante: diasDeEstoqueRestante !== null ? Math.round(diasDeEstoqueRestante * 10) / 10 : null,
      urgencia,
      mensagemUrgencia,
      precisaComprar,
      quantidadeSugerida,
      custoUnitario: precoCusto || null,
      investimentoLinha: precoCusto ? Math.round(quantidadeSugerida * precoCusto * 100) / 100 : null,
      faturamento90d: Math.round(v.receita90 * 100) / 100,
    };
  });

  classificarABC(itens);

  const ordemUrgencia = { atrasado: 0, comprar: 1, ok: 2, sem_dado: 3 };
  itens.sort((a, b) => {
    if (a.precisaComprar !== b.precisaComprar) return a.precisaComprar ? -1 : 1;
    if (ordemUrgencia[a.urgencia] !== ordemUrgencia[b.urgencia]) return ordemUrgencia[a.urgencia] - ordemUrgencia[b.urgencia];
    const ordemClasse = { A: 0, B: 1, C: 2, '—': 3 };
    if (ordemClasse[a.classeABC] !== ordemClasse[b.classeABC]) return ordemClasse[a.classeABC] - ordemClasse[b.classeABC];
    return (a.diasDeEstoqueRestante ?? Infinity) - (b.diasDeEstoqueRestante ?? Infinity);
  });

  return itens;
}

async function salvar(itens, totalPedidosAnalisados) {
  const paraComprar = itens.filter((i) => i.precisaComprar);
  const comCusto = paraComprar.filter((i) => i.investimentoLinha !== null);
  const atrasados = itens.filter((i) => i.urgencia === 'atrasado');

  const resultado = {
    atualizadoEm: new Date().toISOString(),
    parametros: {
      leadTimeDias: LEAD_TIME_DIAS,
      segurancaDias: SEGURANCA_DIAS,
      coberturaAlvoDias: COBERTURA_ALVO_DIAS,
      janelaAnaliseDias: JANELA_DIAS,
      janelaRecenteDias: JANELA_RECENTE_DIAS,
      canalConsiderado: 'E-commerce (Mercado Livre + Bagy)',
      criterioABC: 'faturamento',
    },
    resumo: {
      totalProdutosAnalisados: itens.length,
      totalPedidosAnalisados,
      totalParaComprar: paraComprar.length,
      totalAtrasados: atrasados.length,
      classeA_paraComprar: paraComprar.filter((i) => i.classeABC === 'A').length,
      classeB_paraComprar: paraComprar.filter((i) => i.classeABC === 'B').length,
      classeC_paraComprar: paraComprar.filter((i) => i.classeABC === 'C').length,
      investimentoEstimado: Math.round(comCusto.reduce((s, i) => s + i.investimentoLinha, 0) * 100) / 100,
      produtosSemDadoCusto: paraComprar.length - comCusto.length,
    },
    itens,
  };

  await publicarDados('lista-compras.json', resultado);
  console.log(`Lista de compras publicada (${paraComprar.length} produto(s) pra comprar de ${itens.length} analisados).`);
}

async function main() {
  const token = await getBlingAccessToken();

  console.log('Buscando produtos ativos...');
  const produtos = await getProdutosAtivos(token);
  console.log(`${Object.keys(produtos).length} produtos ativos.`);

  console.log('Buscando estoque atual...');
  const estoqueAtual = await getEstoqueAtual(token, produtos);

  console.log('Buscando pedidos de venda (todos os canais) dos últimos 90 dias...');
  const pedidos = await getPedidosVendas(token);
  console.log(`${pedidos.length} pedido(s) não cancelado(s) encontrado(s). Buscando itens de cada um...`);

  const vendas = await getVendasPorSku(token, pedidos);

  const itens = montarLista(produtos, estoqueAtual, vendas);
  await salvar(itens, pedidos.length);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Erro ao gerar lista de compras:', err.response?.data || err.message);
    process.exit(1);
  });
}
