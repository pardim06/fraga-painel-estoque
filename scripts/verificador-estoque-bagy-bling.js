// scripts/verificador-estoque-bagy-bling.js
//
// Verifica divergência entre o estoque do Bling e o estoque publicado na
// loja Bagy (fragabikeshop.com.br) e corrige o sentido de risco (Bling <
// Bagy). Roda via GitHub Actions, a cada 5min — chamado de dentro do
// verificador-estoque-ml-bling.js (veja rodarVerificacaoBagy abaixo).
//
// IMPORTANTE: o Bling gira o refresh_token a cada uso — se esse script
// chamasse getBlingAccessToken() de novo aqui, um segundo processo/step na
// mesma execução do workflow usaria um token já invalidado pelo primeiro
// (foi exatamente isso que quebrou quando isso rodava como step separado).
// Por isso recebe blingToken/estoqueBling já prontos de quem chamou.
//
// Mesmo padrão do verificador-estoque-ml-bling.js: só corrige o sentido que
// tem risco real de vender sem estoque (Bling < Bagy); Bling > Bagy não é
// mexido automaticamente, só sobra estoque não anunciado, sem risco.

const fs = require('fs');
const path = require('path');
require('dotenv').config(); // no-op em produção: GitHub Actions já injeta as env vars diretamente
const axios = require('axios');
const { getBlingAccessToken } = require('../lib/tokens');
const { getEstoqueBling } = require('../lib/bling-estoque');
const { aguardar } = require('../lib/bling-http');
const { enviarNotificacao } = require('../lib/notificar');

const OUTPUT_PATH = path.join(__dirname, '..', 'resultado-bagy.json');
// Mesmo arquivo do verificador do ML — "furos evitados por mês" no
// dashboard é uma métrica do negócio como um todo, não por canal.
const HISTORICO_MENSAL_PATH = path.join(__dirname, '..', 'historico-mensal.json');
const BAGY_ACCESS_TOKEN = process.env.BAGY_ACCESS_TOKEN;

// ===== ESTOQUE PUBLICADO NA BAGY =====
// Retorna um mapa { sku: { saldo, nome, variationId } }. O estoque de
// verdade mora na variação (variations[].balance), não no produto — mesmo
// produto sem variação visível no site aparece aqui como 1 variação única
// (confirmado testando contra a loja real). sku/external_id/reference da
// variação são sempre iguais entre si e batem com o "codigo" do Bling.
// variationId (variations[].id) é o que a API de correção de estoque da
// Bagy espera — não é o mesmo que o sku.
async function getEstoqueBagy() {
  const estoques = {};
  let page = 1;

  while (true) {
    const resp = await axios.get('https://api.dooca.store/products', {
      headers: { Authorization: `Bearer ${BAGY_ACCESS_TOKEN}` },
      params: { limit: 100, page },
    });

    const produtos = resp.data.data || [];
    if (produtos.length === 0) break;

    for (const produto of produtos) {
      if (!produto.active) continue;

      for (const v of produto.variations || []) {
        if (v.active === false) continue;
        const sku = v.sku || v.external_id || v.reference;
        if (!sku) continue;

        const saldo = (v.balance || 0) - (v.reserved_balance || 0);
        estoques[sku] = { saldo, nome: produto.name, variationId: v.id };
      }
    }

    const totalPaginas = resp.data.meta?.last_page || page;
    if (page >= totalPaginas) break;
    page++;
  }

  return estoques;
}

// ===== COMPARAÇÃO =====
function compararEstoques(estoqueBling, estoqueBagy) {
  const divergencias = [];
  const semSkuNoBling = [];

  for (const sku in estoqueBagy) {
    const bling = estoqueBling[sku];
    const bagy = estoqueBagy[sku];

    if (bling === undefined) {
      semSkuNoBling.push(sku);
      continue;
    }

    // Sinal importa: positivo = Bling tem mais que a Bagy (só perde exposição
    // de venda); negativo = Bling tem menos que a Bagy publicada (risco real
    // de vender sem estoque).
    const diferenca = bling.saldo - bagy.saldo;
    if (diferenca !== 0) {
      divergencias.push({
        sku,
        nome: bling.nome || bagy.nome,
        qtdBling: bling.saldo,
        qtdBagy: bagy.saldo,
        diferenca,
        variationId: bagy.variationId, // uso interno (corrigirEstoqueBagy)
      });
    }
  }

  return { divergencias, semSkuNoBling };
}

// ===== CORREÇÃO AUTOMÁTICA NA BAGY =====
// Só corrige o sentido de risco (Bling < Bagy): atualiza o saldo da
// variação na Bagy pra bater com o saldo real do Bling. Bling > Bagy não é
// mexido automaticamente — só sobra estoque não anunciado, sem risco.
//
// Saldo negativo no Bling (produto vendido sem ter, "furo" já consumado)
// vira 0 na Bagy — uma vitrine não tem como mostrar "-1 unidade", e o
// objetivo aqui é parar de vender, não representar o furo.
//
// A API da Bagy aceita lote de até 150 (PUT /stocks, array de
// {variation_id, balance}) — bem mais eficiente que 1 chamada por SKU.
const BAGY_LOTE_MAX = 150;

async function corrigirEstoqueBagy(divergencias) {
  const paraCorrigir = divergencias.filter((d) => d.diferenca < 0 && d.variationId);

  for (let i = 0; i < paraCorrigir.length; i += BAGY_LOTE_MAX) {
    const lote = paraCorrigir.slice(i, i + BAGY_LOTE_MAX);
    const body = lote.map((d) => ({
      variation_id: d.variationId,
      balance: Math.max(0, d.qtdBling),
    }));

    try {
      const resp = await axios.put('https://api.dooca.store/stocks', body, {
        headers: { Authorization: `Bearer ${BAGY_ACCESS_TOKEN}` },
      });
      // A Bagy não dá erro HTTP pra variação inexistente — só lista o id em
      // variations_not_found. Sem isso, um produto excluído/renomeado na
      // Bagy pareceria "corrigido" sem ter sido de fato.
      const naoEncontradas = new Set(resp.data?.variations_not_found || []);

      lote.forEach((d) => {
        if (naoEncontradas.has(d.variationId)) {
          d.corrigido = false;
          d.corrigidoDetalhe = 'Variação não encontrada na Bagy (produto pode ter sido excluído/alterado)';
        } else {
          d.corrigido = true;
          d.corrigidoDetalhe = `Atualizado para ${Math.max(0, d.qtdBling)}`;
        }
      });
      console.log(`Lote de ${lote.length} SKU(s) processado(s) na Bagy (${naoEncontradas.size} não encontrada(s)).`);
    } catch (err) {
      const erro = err.response?.data?.message || err.message;
      lote.forEach((d) => {
        d.corrigido = false;
        d.corrigidoDetalhe = `Falha ao corrigir: ${erro}`;
      });
      console.log(`Falha ao corrigir lote de ${lote.length} SKU(s) na Bagy: ${erro}`);
    }

    await aguardar(300);
  }
}

// ===== ALERTA DE RISCO (WhatsApp/e-mail) =====
// Só avisa dos casos que a correção automática NÃO conseguiu resolver
// sozinha — o que corrigiu não precisa acordar ninguém, já está resolvido.
async function enviarAlertaRisco(divergencias) {
  const risco = divergencias.filter((d) => d.diferenca < 0 && !d.corrigido);
  if (risco.length === 0) return;

  const LIMITE_ITENS = 15;
  const separador = '----------------------------';

  let corpo = `*RISCO DE FURO NA BAGY - CORRECAO AUTOMATICA FALHOU*\n${risco.length} produto(s) precisam de atencao manual\n`;

  for (const d of risco.slice(0, LIMITE_ITENS)) {
    corpo +=
      `\n${separador}\n` +
      `*SKU ${d.sku}*\n` +
      `${d.nome || 'sem nome'}\n` +
      `Bling: ${d.qtdBling}  |  Bagy: ${d.qtdBagy}\n` +
      `Motivo: ${d.corrigidoDetalhe || 'nao corrigido'}\n`;
  }

  if (risco.length > LIMITE_ITENS) {
    corpo += `\n${separador}\n... e mais ${risco.length - LIMITE_ITENS} produto(s) em risco. Veja todos no painel.\n`;
  }

  const enviado = await enviarNotificacao(corpo, `Risco de furo de estoque na Bagy - ${risco.length} SKU(s)`);
  if (enviado) {
    console.log(`Alerta enviado (${risco.length} SKU(s) em risco na Bagy).`);
  }
}

// ===== HISTÓRICO MENSAL (furos evitados por mês, compartilhado com o ML) =====
function registrarHistoricoMensal(divergencias) {
  const corrigidosAgora = divergencias.filter((d) => d.corrigido).length;

  let porMes = {};
  if (fs.existsSync(HISTORICO_MENSAL_PATH)) {
    try {
      porMes = JSON.parse(fs.readFileSync(HISTORICO_MENSAL_PATH, 'utf8'));
    } catch {
      porMes = {};
    }
  }

  // Sempre escreve o arquivo, mesmo sem correção nova — senão o "git add"
  // do Actions falha com pathspec não encontrado num ciclo sem correção.
  const chave = new Date().toISOString().slice(0, 7); // "2026-08"
  porMes[chave] = (porMes[chave] || 0) + corrigidosAgora;

  fs.writeFileSync(HISTORICO_MENSAL_PATH, JSON.stringify(porMes, null, 2));
  if (corrigidosAgora > 0) {
    console.log(`Histórico mensal atualizado: +${corrigidosAgora} furo(s) evitado(s) na Bagy.`);
  }
}

// ===== SALVAR RESULTADO PRO PAINEL =====
function salvarResultadoLocal({ totalSkusBagy, divergencias, semSkuNoBling }) {
  const totalComparavel = totalSkusBagy - semSkuNoBling.length;
  const corretos = totalComparavel - divergencias.length;

  const resultado = {
    atualizadoEm: new Date().toISOString(),
    totalSkus: totalComparavel,
    corretos,
    totalDivergentes: divergencias.length,
    // "variationId" é só uso interno (corrigirEstoqueBagy), não vai pro painel.
    divergencias: divergencias.map(({ variationId, ...resto }) => resto),
    semSkuNoBling,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(resultado, null, 2));
  console.log(`Resultado salvo em ${OUTPUT_PATH}`);
}

// ===== EXECUÇÃO =====
// Recebe o estoque do Bling já buscado por quem chamou (veja o comentário
// no topo do arquivo — evita um segundo refresh do Bling na mesma
// execução do workflow).
async function rodarVerificacaoBagy(estoqueBling) {
  if (!BAGY_ACCESS_TOKEN) {
    console.log('BAGY_ACCESS_TOKEN não configurado, pulando verificação da Bagy.');
    return;
  }

  const estoqueBagy = await getEstoqueBagy();

  const { divergencias, semSkuNoBling } = compararEstoques(estoqueBling, estoqueBagy);
  const totalSkusBagy = Object.keys(estoqueBagy).length;

  console.log(`Verificação Bagy x Bling concluída: ${divergencias.length} divergências encontradas.`);
  if (semSkuNoBling.length > 0) {
    console.log(`Aviso: ${semSkuNoBling.length} SKUs da Bagy não foram encontrados no Bling (verifique cadastro).`);
  }

  await corrigirEstoqueBagy(divergencias);
  registrarHistoricoMensal(divergencias);
  await enviarAlertaRisco(divergencias);
  salvarResultadoLocal({ totalSkusBagy, divergencias, semSkuNoBling });
}

module.exports = { rodarVerificacaoBagy };

// Uso standalone (local/manual) — busca o token/estoque do Bling sozinho,
// já que nesse caso não tem nenhum outro processo disputando o refresh.
if (require.main === module) {
  (async () => {
    if (!BAGY_ACCESS_TOKEN) {
      throw new Error('BAGY_ACCESS_TOKEN não configurado (.env local ou GitHub Secret).');
    }
    const blingToken = await getBlingAccessToken();
    const estoqueBling = await getEstoqueBling(blingToken);
    await rodarVerificacaoBagy(estoqueBling);
  })().catch((err) => {
    console.error('Erro na verificação de estoque Bagy x Bling:', err.response?.data || err.message);
    process.exit(1);
  });
}
