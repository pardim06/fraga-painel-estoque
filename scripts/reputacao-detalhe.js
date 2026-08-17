// scripts/reputacao-detalhe.js
//
// Reconstrói, ocorrência por ocorrência, o que está compondo a taxa de
// cancelamento e de reclamação da reputação ML (que hoje só mostra a taxa
// e a quantidade agregada, sem dizer QUANDO cada uma sai da janela de
// 60 dias). Com isso dá pra saber "em quantos dias essa taxa cai sozinha,
// se eu não fizer mais nenhuma".
//
// CANCELAMENTO: confiável — usa /orders/search (status cancelled,
// cancel_detail.requested_by === 'seller'), validado batendo bem perto do
// número oficial da reputação.
//
// RECLAMAÇÃO: estimativa — usa /post-purchase/v1/claims/search
// (type=mediations), excluindo as que resolveram só a favor do comprador.
// Essa fórmula bateu com o número oficial no dia em que foi testada, mas o
// Mercado Livre não documenta o critério exato da métrica — pode não bater
// 100% sempre. Sinalizado como estimativa no painel.

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const axios = require('axios');
const { getMLAccessToken } = require('../lib/tokens');

const OUTPUT_PATH = path.join(__dirname, '..', 'reputacao-detalhe.json');
const REPUTACAO_PATH = path.join(__dirname, '..', 'reputacao-ml.json');
const JANELA_DIAS = 60;

function diasRestantes(dataIso) {
  const passados = Math.floor((Date.now() - new Date(dataIso).getTime()) / (24 * 60 * 60 * 1000));
  return Math.max(0, JANELA_DIAS - passados);
}

function dataSaida(dataIso) {
  const saida = new Date(dataIso);
  saida.setDate(saida.getDate() + JANELA_DIAS);
  return saida.toISOString();
}

async function buscarCancelamentosPeloVendedor(token, sellerId) {
  const de = new Date(Date.now() - JANELA_DIAS * 24 * 60 * 60 * 1000).toISOString();
  const ate = new Date().toISOString();
  const todos = [];
  let offset = 0;

  while (true) {
    const resp = await axios.get('https://api.mercadolibre.com/orders/search', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        seller: sellerId,
        'order.status': 'cancelled',
        'order.date_created.from': de,
        'order.date_created.to': ate,
        limit: 50,
        offset,
      },
    });
    todos.push(...resp.data.results);
    offset += 50;
    if (offset >= resp.data.paging.total || resp.data.results.length === 0) break;
  }

  return todos
    .filter((o) => o.cancel_detail?.requested_by === 'seller')
    .map((o) => ({
      id: o.id,
      data: o.date_created,
      motivo: o.cancel_detail?.description || o.cancel_detail?.code || null,
    }));
}

async function buscarReclamacoesEstimativa(token, sellerId) {
  const de = new Date(Date.now() - JANELA_DIAS * 24 * 60 * 60 * 1000).toISOString();
  const ate = new Date().toISOString();
  const todos = [];
  let offset = 0;

  while (true) {
    const resp = await axios.get('https://api.mercadolibre.com/post-purchase/v1/claims/search', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        'players.user_id': sellerId,
        'players.role': 'respondent',
        site_id: 'MLB',
        type: 'mediations',
        range: `date_created:after:${de},before:${ate}`,
        limit: 50,
        offset,
      },
    });
    todos.push(...resp.data.data);
    offset += 50;
    if (offset >= resp.data.paging.total || resp.data.data.length === 0) break;
  }

  // Exclui as que resolveram só a favor do comprador — o que sobra é a
  // estimativa que bateu com o número oficial no teste.
  return todos
    .filter((c) => !(c.resolution?.benefited?.length === 1 && c.resolution.benefited[0] === 'complainant'))
    .map((c) => ({
      id: c.id,
      data: c.date_created,
      motivo: c.reason_id || null,
    }));
}

function montarResumo(ocorrencias) {
  const comDias = ocorrencias
    .map((o) => ({ ...o, diasRestantes: diasRestantes(o.data), saiEm: dataSaida(o.data) }))
    .sort((a, b) => a.diasRestantes - b.diasRestantes);

  return {
    quantidade: comDias.length,
    diasParaZerar: comDias.length > 0 ? Math.max(...comDias.map((o) => o.diasRestantes)) : 0,
    ocorrencias: comDias,
  };
}

async function main() {
  const token = await getMLAccessToken();
  const sellerId = process.env.ML_SELLER_ID;

  const [cancelamentos, reclamacoes] = await Promise.all([
    buscarCancelamentosPeloVendedor(token, sellerId),
    buscarReclamacoesEstimativa(token, sellerId),
  ]);

  let oficial = { cancelamento: null, reclamacao: null };
  if (fs.existsSync(REPUTACAO_PATH)) {
    try {
      const dados = JSON.parse(fs.readFileSync(REPUTACAO_PATH, 'utf8'));
      oficial.cancelamento = dados.metricas?.cancelamento?.quantidade ?? null;
      oficial.reclamacao = dados.metricas?.reclamacao?.quantidade ?? null;
    } catch {
      // segue sem o número oficial pra comparar, não é crítico
    }
  }

  const resultado = {
    atualizadoEm: new Date().toISOString(),
    janelaDias: JANELA_DIAS,
    cancelamento: { ...montarResumo(cancelamentos), quantidadeOficial: oficial.cancelamento, estimativa: false },
    reclamacao: { ...montarResumo(reclamacoes), quantidadeOficial: oficial.reclamacao, estimativa: true },
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(resultado, null, 2));
  console.log(
    `Detalhe de reputação salvo: cancelamento ${resultado.cancelamento.quantidade} (oficial: ${oficial.cancelamento}), ` +
      `reclamação ${resultado.reclamacao.quantidade} estimado (oficial: ${oficial.reclamacao}).`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Erro ao detalhar reputação:', err.response?.data || err.message);
    process.exit(1);
  });
}
