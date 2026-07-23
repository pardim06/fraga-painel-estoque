// verificador-estoque-ml-bling.js
//
// Verifica divergência entre o estoque do Bling e o estoque publicado no
// Mercado Livre, e (opcionalmente) avisa via WhatsApp (Z-API) quando encontrar
// diferença. Roda via GitHub Actions (cron a cada 10 minutos) — veja
// .github/workflows/verificar-estoque.yml.
//
// IMPORTANTE: os nomes de campos do Bling (produto.codigo, saldoFisicoTotal)
// e do ML (seller_custom_field) podem variar conforme sua configuração de
// catálogo. Confirme contra o retorno real da sua conta antes de colocar em
// produção — a Bling e o ML atualizam a API de vez em quando.

const fs = require('fs');
const path = require('path');
require('dotenv').config(); // no-op em produção: GitHub Actions já injeta as env vars diretamente
const axios = require('axios');
const { getBlingAccessToken, getMLAccessToken } = require('./lib/tokens');

// ===== CONFIG (variáveis de ambiente / GitHub Secrets) =====
const OUTPUT_PATH = path.join(__dirname, 'resultado-verificacao.json');

// Depósito "1 - SITE / MERCADO LIVRE" — só o estoque desse depósito deve ser
// comparado com o ML (os outros são lojas físicas, reserva, eventos etc.).
const BLING_DEPOSITO_ID = process.env.BLING_DEPOSITO_ID || '14887750294';
const ML_SELLER_ID = process.env.ML_SELLER_ID;

// Opcionais — se não configurados, o envio de WhatsApp é simplesmente pulado.
const ZAPI_INSTANCE_URL = process.env.ZAPI_INSTANCE_URL; // ex: https://api.z-api.io/instances/SEU_ID/token/SEU_TOKEN
const WHATSAPP_DESTINO = process.env.WHATSAPP_DESTINO; // seu número, ex: 5531999999999

const TOLERANCIA = 0; // diferença mínima pra considerar divergência (0 = qualquer diferença já dispara)

// Bling limita a 3 requisições/segundo. Espera entre chamadas e tenta de novo
// (com backoff) se ainda assim tomar 429 — evita derrubar a verificação inteira
// por causa do rate limit.
const aguardar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function blingGet(url, config, tentativa = 1) {
  await aguardar(400); // ~2.5 req/s, com folga do limite de 3/s
  try {
    return await axios.get(url, config);
  } catch (err) {
    if (err.response?.status === 429 && tentativa <= 4) {
      await aguardar(1000 * tentativa);
      return blingGet(url, config, tentativa + 1);
    }
    throw err;
  }
}

// ===== 2. ESTOQUE NO BLING =====
// Retorna um mapa { sku: quantidade }
// Usa só o saldo do depósito "SITE / MERCADO LIVRE" (BLING_DEPOSITO_ID) — o
// saldo agregado de /produtos soma também lojas físicas e outros depósitos,
// o que não é o estoque de fato publicado no ML.
async function getEstoqueBling(accessToken) {
  // 1. lista todos os produtos ativos, exceto os "pai" com variações (formato "V"):
  // { id -> {codigo, nome} }. Um produto pai não tem saldo próprio — quem carrega
  // o estoque de verdade são as variações filhas, que já aparecem nessa mesma
  // listagem como itens separados (formato "S"). Kits (formato "E") têm saldo
  // próprio normalmente e entram na comparação como qualquer produto simples.
  const infoPorId = {};
  let pagina = 1;

  while (true) {
    const resp = await blingGet('https://www.bling.com.br/Api/v3/produtos', {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { pagina, limite: 100, situacao: 'A' }, // só produtos ativos
    });

    const dados = resp.data.data || [];
    if (dados.length === 0) break;

    for (const item of dados) {
      if (item.codigo && item.formato !== 'V') {
        infoPorId[item.id] = { codigo: item.codigo, nome: item.nome };
      }
    }

    pagina++;
  }

  // 2. busca o saldo por depósito em lotes (idsProdutos)
  const estoques = {};
  const idsProdutos = Object.keys(infoPorId);
  const TAMANHO_LOTE = 50;

  for (let i = 0; i < idsProdutos.length; i += TAMANHO_LOTE) {
    const lote = idsProdutos.slice(i, i + TAMANHO_LOTE);
    const resp = await blingGet('https://www.bling.com.br/Api/v3/estoques/saldos', {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { idsProdutos: lote },
    });

    for (const item of resp.data.data || []) {
      const info = infoPorId[item.produto?.id];
      const sku = item.produto?.codigo ?? info?.codigo;
      const depositoSite = item.depositos?.find((d) => String(d.id) === String(BLING_DEPOSITO_ID));
      const saldo = depositoSite?.saldoVirtual ?? depositoSite?.saldoFisico;
      if (sku && saldo !== undefined) estoques[sku] = { saldo, nome: info?.nome };
    }
  }

  return estoques;
}

// ===== 4. ESTOQUE PUBLICADO NO ML =====
// Retorna um mapa { sku: quantidade_disponivel }
async function getEstoqueML(accessToken) {
  const estoques = {};
  let offset = 0;
  const limit = 50;

  while (true) {
    const resp = await axios.get(`https://api.mercadolibre.com/users/${ML_SELLER_ID}/items/search`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { offset, limit, status: 'active' },
    });

    const ids = resp.data.results || [];
    if (ids.length === 0) break;

    // busca detalhes em lote (multiget, máximo 20 por chamada na maioria das contas)
    for (let i = 0; i < ids.length; i += 20) {
      const lote = ids.slice(i, i + 20);
      const detalhes = await axios.get('https://api.mercadolibre.com/items', {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { ids: lote.join(',') },
      });

      for (const entry of detalhes.data) {
        const item = entry.body;
        const sku =
          item.seller_custom_field ||
          item.attributes?.find((a) => a.id === 'SELLER_SKU')?.value_name;
        if (!sku) continue;

        // Um mesmo SKU pode ter mais de um anúncio ativo (ex: clássico + premium,
        // ou republicação sem pausar o anterior). Na prática o Bling sincroniza o
        // MESMO saldo total pra cada anúncio (não divide o estoque entre eles), então
        // soma contaria o mesmo estoque várias vezes. Usa o maior valor entre os
        // anúncios — se estiverem dessincronizados entre si, o maior é o mais
        // otimista/atual e ainda assim compara de forma justa contra o Bling.
        if (estoques[sku]) {
          estoques[sku].qtd = Math.max(estoques[sku].qtd, item.available_quantity);
        } else {
          estoques[sku] = { qtd: item.available_quantity, nome: item.title };
        }
      }
    }

    offset += limit;
  }

  return estoques;
}

// ===== 5. COMPARAÇÃO =====
function compararEstoques(estoqueBling, estoqueML) {
  const divergencias = [];
  const semSkuNoBling = [];

  for (const sku in estoqueML) {
    const bling = estoqueBling[sku];
    const ml = estoqueML[sku];

    if (bling === undefined) {
      semSkuNoBling.push(sku);
      continue;
    }

    // Sinal importa: positivo = Bling tem mais que o ML (só perde exposição
    // de venda); negativo = Bling tem menos que o ML publicado (risco real
    // de vender sem estoque).
    const diferenca = bling.saldo - ml.qtd;
    if (Math.abs(diferenca) > TOLERANCIA) {
      divergencias.push({
        sku,
        nome: bling.nome || ml.nome,
        qtdBling: bling.saldo,
        qtdML: ml.qtd,
        diferenca,
      });
    }
  }

  return { divergencias, semSkuNoBling };
}

// ===== 6. ENVIO WHATSAPP (Z-API, opcional) =====
async function enviarAlertaWhatsapp(divergencias) {
  if (divergencias.length === 0) return;
  if (!ZAPI_INSTANCE_URL || !WHATSAPP_DESTINO) {
    console.log('Z-API não configurado, pulando alerta de WhatsApp.');
    return;
  }

  let mensagem = `Divergencia de estoque Bling x ML (${divergencias.length} SKUs)\n\n`;

  for (const d of divergencias.slice(0, 20)) {
    const sinal = d.diferenca > 0 ? '+' : '';
    mensagem += `SKU ${d.sku}: Bling ${d.qtdBling} | ML ${d.qtdML} | diferenca ${sinal}${d.diferenca}\n`;
  }

  if (divergencias.length > 20) {
    mensagem += `\n... e mais ${divergencias.length - 20} SKUs divergentes.`;
  }

  await axios.post(`${ZAPI_INSTANCE_URL}/send-text`, {
    phone: WHATSAPP_DESTINO,
    message: mensagem,
  });
}

// ===== 7. SALVAR RESULTADO PRO PAINEL (arquivo local, commitado pelo Actions) =====
function salvarResultadoLocal({ totalSkusML, divergencias, semSkuNoBling }) {
  const corretos = totalSkusML - divergencias.length - semSkuNoBling.length;

  const resultado = {
    atualizadoEm: new Date().toISOString(),
    totalSkus: totalSkusML,
    corretos,
    totalDivergentes: divergencias.length,
    divergencias, // [{ sku, qtdBling, qtdML, diferenca }]
    semSkuNoBling, // skus do ML não encontrados no Bling
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(resultado, null, 2));
  console.log(`Resultado salvo em ${OUTPUT_PATH}`);
}

// ===== EXECUÇÃO =====
async function main() {
  const blingToken = await getBlingAccessToken();
  const estoqueBling = await getEstoqueBling(blingToken);

  const mlToken = await getMLAccessToken();
  const estoqueML = await getEstoqueML(mlToken);

  const { divergencias, semSkuNoBling } = compararEstoques(estoqueBling, estoqueML);
  const totalSkusML = Object.keys(estoqueML).length;

  console.log(`Verificação concluída: ${divergencias.length} divergências encontradas.`);
  if (semSkuNoBling.length > 0) {
    console.log(`Aviso: ${semSkuNoBling.length} SKUs do ML não foram encontrados no Bling (verifique cadastro).`);
  }

  await enviarAlertaWhatsapp(divergencias);
  salvarResultadoLocal({ totalSkusML, divergencias, semSkuNoBling });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Erro na verificação de estoque:', err.response?.data || err.message);
    process.exit(1);
  });
}
