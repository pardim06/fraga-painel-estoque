// scripts/verificador-estoque-nuvemshop-bling.js
//
// Verifica divergência entre o estoque do Bling e o estoque publicado na
// loja Nuvemshop (fragabikeshop.com.br) e corrige o sentido de risco (Bling
// < Nuvemshop). Roda via GitHub Actions, a cada 5min — chamado de dentro do
// verificador-estoque-ml-bling.js (veja rodarVerificacaoNuvemshop abaixo).
// Substitui a verificação da Bagy (loja trocou de plataforma).
//
// IMPORTANTE: o Bling gira o refresh_token a cada uso — se esse script
// chamasse getBlingAccessToken() de novo aqui, um segundo processo/step na
// mesma execução do workflow usaria um token já invalidado pelo primeiro.
// Por isso recebe blingToken/estoqueBling já prontos de quem chamou (mesmo
// padrão do verificador da Bagy que esse substitui).
//
// Mesmo padrão dos outros verificadores: só corrige o sentido que tem risco
// real de vender sem estoque (Bling < Nuvemshop); Bling > Nuvemshop não é
// mexido automaticamente, só sobra estoque não anunciado, sem risco.

require('dotenv').config();
const { getBlingAccessToken } = require('../lib/tokens');
const { getEstoqueBling } = require('../lib/bling-estoque');
const { nuvemshopGet, nuvemshopPut, aguardar } = require('../lib/nuvemshop-http');
const { enviarNotificacao } = require('../lib/notificar');
const { publicarDados, incrementarHistoricoMensal } = require('../lib/supabase-publicar');

const NUVEMSHOP_ACCESS_TOKEN = process.env.NUVEMSHOP_ACCESS_TOKEN;

// ===== ESTOQUE PUBLICADO NA NUVEMSHOP =====
// Retorna um mapa { sku: { saldo, nome, productId, variantId, locationId } }.
// A loja usa o sistema de "múltiplos locais" da Nuvemshop — o saldo de
// verdade mora em variants[].inventory_levels[], não no campo variants[].stock
// direto (esse fica desatualizado pra correção quando locais estão ativos —
// confirmado testando contra a loja real). Cada variação tem 1 location_id
// só nessa conta; se um dia tiver mais de um local, pega o primeiro.
const POR_PAGINA = 200;

async function getEstoqueNuvemshop() {
  const estoques = {};
  let page = 1;

  while (true) {
    const resp = await nuvemshopGet('/products', { params: { per_page: POR_PAGINA, page } });
    const produtos = resp.data || [];

    for (const produto of produtos) {
      if (!produto.published) continue;

      for (const v of produto.variants || []) {
        if (v.stock_management === false) continue; // estoque "infinito", não comparável
        if (!v.visible) continue;
        const sku = v.sku;
        if (!sku) continue;

        const nivel = v.inventory_levels?.[0];
        const saldo = nivel ? nivel.stock : v.stock;
        if (saldo === null || saldo === undefined) continue; // estoque ilimitado

        estoques[sku] = {
          saldo,
          nome: produto.name?.pt || produto.name,
          productId: produto.id,
          variantId: v.id,
          locationId: nivel?.location_id || null,
        };
      }
    }

    // A API da Nuvemshop devolve ERRO (404 "Last page is N"), não lista
    // vazia, ao pedir uma página além da última — por isso parar com base
    // no tamanho da página recebida, nunca chamar de novo depois da última.
    if (produtos.length < POR_PAGINA) break;
    page++;
  }

  return estoques;
}

// ===== COMPARAÇÃO =====
function compararEstoques(estoqueBling, estoqueNuvemshop) {
  const divergencias = [];
  const semSkuNoBling = [];

  for (const sku in estoqueNuvemshop) {
    const bling = estoqueBling[sku];
    const nuvem = estoqueNuvemshop[sku];

    if (bling === undefined) {
      semSkuNoBling.push(sku);
      continue;
    }

    // Sinal importa: positivo = Bling tem mais que a Nuvemshop (só perde
    // exposição de venda); negativo = Bling tem menos que a Nuvemshop
    // publicada (risco real de vender sem estoque).
    const diferenca = bling.saldo - nuvem.saldo;
    if (diferenca !== 0) {
      divergencias.push({
        sku,
        nome: bling.nome || nuvem.nome,
        qtdBling: bling.saldo,
        qtdNuvemshop: nuvem.saldo,
        diferenca,
        productId: nuvem.productId, // uso interno (corrigirEstoqueNuvemshop)
        variantId: nuvem.variantId,
        locationId: nuvem.locationId,
      });
    }
  }

  return { divergencias, semSkuNoBling };
}

// ===== CORREÇÃO AUTOMÁTICA NA NUVEMSHOP =====
// Só corrige o sentido de risco (Bling < Nuvemshop). Saldo negativo no Bling
// (produto já vendido sem ter, "furo" consumado) vira 0 — a vitrine não tem
// como mostrar "-1 unidade".
async function corrigirEstoqueNuvemshop(divergencias) {
  const paraCorrigir = divergencias.filter((d) => d.diferenca < 0);

  for (const d of paraCorrigir) {
    if (!d.locationId) {
      d.corrigido = false;
      d.corrigidoDetalhe = 'Sem location_id (estoque não gerenciado por local)';
      continue;
    }

    try {
      await nuvemshopPut(`/products/${d.productId}/variants/${d.variantId}`, {
        inventory_levels: [{ location_id: d.locationId, stock: Math.max(0, d.qtdBling) }],
      });
      d.corrigido = true;
      d.corrigidoDetalhe = `Atualizado para ${Math.max(0, d.qtdBling)}`;
    } catch (err) {
      d.corrigido = false;
      d.corrigidoDetalhe = `Falha ao corrigir: ${err.response?.data?.message || err.message}`;
    }

    console.log(`SKU ${d.sku}: ${d.corrigido ? 'corrigido' : 'FALHA ao corrigir'} — ${d.corrigidoDetalhe}`);
    await aguardar(300);
  }
}

// ===== ALERTA DE RISCO (WhatsApp/e-mail) =====
async function enviarAlertaRisco(divergencias) {
  const risco = divergencias.filter((d) => d.diferenca < 0 && !d.corrigido);
  if (risco.length === 0) return;

  const LIMITE_ITENS = 15;
  const separador = '----------------------------';

  let corpo = `*RISCO DE FURO NA NUVEMSHOP - CORRECAO AUTOMATICA FALHOU*\n${risco.length} produto(s) precisam de atencao manual\n`;

  for (const d of risco.slice(0, LIMITE_ITENS)) {
    corpo +=
      `\n${separador}\n` +
      `*SKU ${d.sku}*\n` +
      `${d.nome || 'sem nome'}\n` +
      `Bling: ${d.qtdBling}  |  Nuvemshop: ${d.qtdNuvemshop}\n` +
      `Motivo: ${d.corrigidoDetalhe || 'nao corrigido'}\n`;
  }

  if (risco.length > LIMITE_ITENS) {
    corpo += `\n${separador}\n... e mais ${risco.length - LIMITE_ITENS} produto(s) em risco. Veja todos no painel.\n`;
  }

  const enviado = await enviarNotificacao(corpo, `Risco de furo de estoque na Nuvemshop - ${risco.length} SKU(s)`);
  if (enviado) {
    console.log(`Alerta enviado (${risco.length} SKU(s) em risco na Nuvemshop).`);
  }
}

// ===== PUBLICAR RESULTADO PRO PAINEL =====
async function salvarResultadoLocal({ totalSkusNuvemshop, divergencias, semSkuNoBling }) {
  const totalComparavel = totalSkusNuvemshop - semSkuNoBling.length;
  const corretos = totalComparavel - divergencias.length;

  const resultado = {
    atualizadoEm: new Date().toISOString(),
    totalSkus: totalComparavel,
    corretos,
    totalDivergentes: divergencias.length,
    divergencias: divergencias.map(({ productId, variantId, locationId, ...resto }) => resto),
    semSkuNoBling,
  };

  await publicarDados('resultado-nuvemshop.json', resultado);
}

// ===== EXECUÇÃO =====
async function rodarVerificacaoNuvemshop(estoqueBling) {
  if (!NUVEMSHOP_ACCESS_TOKEN) {
    console.log('NUVEMSHOP_ACCESS_TOKEN não configurado, pulando verificação da Nuvemshop.');
    return;
  }

  const estoqueNuvemshop = await getEstoqueNuvemshop();

  const { divergencias, semSkuNoBling } = compararEstoques(estoqueBling, estoqueNuvemshop);
  const totalSkusNuvemshop = Object.keys(estoqueNuvemshop).length;

  console.log(`Verificação Nuvemshop x Bling concluída: ${divergencias.length} divergências encontradas.`);
  if (semSkuNoBling.length > 0) {
    console.log(`Aviso: ${semSkuNoBling.length} SKUs da Nuvemshop não foram encontrados no Bling (verifique cadastro).`);
  }

  await corrigirEstoqueNuvemshop(divergencias);
  await incrementarHistoricoMensal(divergencias.filter((d) => d.corrigido).length);
  await enviarAlertaRisco(divergencias);
  await salvarResultadoLocal({ totalSkusNuvemshop, divergencias, semSkuNoBling });
}

module.exports = { rodarVerificacaoNuvemshop };

// Uso standalone (local/manual)
if (require.main === module) {
  (async () => {
    if (!NUVEMSHOP_ACCESS_TOKEN) {
      throw new Error('NUVEMSHOP_ACCESS_TOKEN não configurado (.env local ou GitHub Secret).');
    }
    const blingToken = await getBlingAccessToken();
    const estoqueBling = await getEstoqueBling(blingToken);
    await rodarVerificacaoNuvemshop(estoqueBling);
  })().catch((err) => {
    console.error('Erro na verificação de estoque Nuvemshop x Bling:', err.response?.data || err.message);
    process.exit(1);
  });
}
