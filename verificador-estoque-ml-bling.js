// verificador-estoque-ml-bling.js
//
// Verifica divergência entre o estoque do Bling e o estoque publicado no
// Mercado Livre, e (opcionalmente) avisa via WhatsApp (Z-API) quando encontrar
// diferença. Roda via GitHub Actions (cron a cada 15 minutos) — veja
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
const nodemailer = require('nodemailer');
const { getBlingAccessToken, getMLAccessToken } = require('./lib/tokens');

// ===== CONFIG (variáveis de ambiente / GitHub Secrets) =====
const OUTPUT_PATH = path.join(__dirname, 'resultado-verificacao.json');

// Depósito "1 - SITE / MERCADO LIVRE" — só o estoque desse depósito deve ser
// comparado com o ML (os outros são lojas físicas, reserva, eventos etc.).
const BLING_DEPOSITO_ID = process.env.BLING_DEPOSITO_ID || '14887750294';
const ML_SELLER_ID = process.env.ML_SELLER_ID;

// Opcionais — se não configurados, o alerta é simplesmente pulado. Tenta
// nessa ordem: CallMeBot (WhatsApp grátis) → Z-API (WhatsApp pago) → e-mail
// via Gmail (grátis, fallback atual enquanto o WhatsApp não fica estável).
const CALLMEBOT_PHONE = process.env.CALLMEBOT_PHONE; // seu número, ex: 5531999999999
const CALLMEBOT_APIKEY = process.env.CALLMEBOT_APIKEY;
const ZAPI_INSTANCE_URL = process.env.ZAPI_INSTANCE_URL; // ex: https://api.z-api.io/instances/SEU_ID/token/SEU_TOKEN
const WHATSAPP_DESTINO = process.env.WHATSAPP_DESTINO; // seu número, ex: 5531999999999
const GMAIL_USER = process.env.GMAIL_USER; // ex: voce@gmail.com
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD; // senha de app de 16 caracteres, nao a senha normal
const EMAIL_DESTINO = process.env.EMAIL_DESTINO || GMAIL_USER; // pra onde manda o alerta (padrao: o proprio remetente)

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
        // ou republicação sem pausar o anterior). Guarda todos os item_id — a
        // correção automática precisa atualizar TODOS eles, não só um. Pra
        // comparação usa o maior valor entre os anúncios (na prática o Bling
        // sincroniza o mesmo saldo pra cada um; se estiverem dessincronizados
        // entre si, o maior é o mais otimista/atual).
        if (estoques[sku]) {
          estoques[sku].qtd = Math.max(estoques[sku].qtd, item.available_quantity);
          estoques[sku].itens.push({ itemId: item.id, qtd: item.available_quantity });
        } else {
          estoques[sku] = {
            qtd: item.available_quantity,
            nome: item.title,
            itens: [{ itemId: item.id, qtd: item.available_quantity }],
          };
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
        itens: ml.itens, // uso interno (corrigirEstoqueML) — removido antes de salvar o JSON
      });
    }
  }

  return { divergencias, semSkuNoBling };
}

// ===== 5b. CORREÇÃO AUTOMÁTICA NO ML =====
// Só corrige o sentido de risco (Bling < ML): atualiza o(s) anúncio(s) do ML
// pra baterem com o saldo real do Bling, que é a fonte da verdade. Bling > ML
// não é mexido automaticamente — só sobra estoque não anunciado, sem risco.
async function corrigirEstoqueML(accessToken, divergencias) {
  for (const d of divergencias) {
    if (d.diferenca >= 0) continue; // só corrige quando Bling < ML

    const resultadosPorItem = [];
    for (const item of d.itens) {
      try {
        await axios.put(
          `https://api.mercadolibre.com/items/${item.itemId}`,
          { available_quantity: d.qtdBling },
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        resultadosPorItem.push({ itemId: item.itemId, ok: true });
      } catch (err) {
        resultadosPorItem.push({
          itemId: item.itemId,
          ok: false,
          erro: err.response?.data?.message || err.message,
        });
      }
      await aguardar(250); // folga entre chamadas de escrita no ML
    }

    const falhas = resultadosPorItem.filter((r) => !r.ok);
    d.corrigido = falhas.length === 0;
    d.corrigidoDetalhe = d.corrigido
      ? `${resultadosPorItem.length} anúncio(s) atualizado(s) para ${d.qtdBling}`
      : `Falha em ${falhas.length}/${resultadosPorItem.length} anúncio(s): ${falhas[0].erro}`;

    console.log(
      `SKU ${d.sku}: ${d.corrigido ? 'corrigido' : 'FALHA ao corrigir'} — ${d.corrigidoDetalhe}`
    );
  }
}

// ===== 6. ALERTA DE RISCO (WhatsApp via CallMeBot/Z-API, ou e-mail via Gmail) =====
// Só avisa dos casos que a correção automática NÃO conseguiu resolver sozinha
// (ex: anúncio pausado, erro da API do ML) — o que corrigiu não precisa
// acordar ninguém, já está resolvido.
async function enviarAlertaRisco(divergencias) {
  const risco = divergencias.filter((d) => d.diferenca < 0 && !d.corrigido);
  if (risco.length === 0) return;

  const LIMITE_ITENS = 15;
  const separador = '----------------------------';

  let corpo = `*RISCO DE FURO - CORRECAO AUTOMATICA FALHOU*\n${risco.length} produto(s) precisam de atencao manual\n`;

  for (const d of risco.slice(0, LIMITE_ITENS)) {
    corpo +=
      `\n${separador}\n` +
      `*SKU ${d.sku}*\n` +
      `${d.nome || 'sem nome'}\n` +
      `Bling: ${d.qtdBling}  |  ML: ${d.qtdML}\n` +
      `Faltam *${Math.abs(d.diferenca)}* unidade(s)\n` +
      `Motivo: ${d.corrigidoDetalhe || 'nao corrigido'}\n`;
  }

  if (risco.length > LIMITE_ITENS) {
    corpo += `\n${separador}\n... e mais ${risco.length - LIMITE_ITENS} produto(s) em risco. Veja todos no painel.\n`;
  }

  if (CALLMEBOT_PHONE && CALLMEBOT_APIKEY) {
    // A API gratuita do CallMeBot rejeita mensagem com acento (ç, ã, ê etc.)
    // com "invalid charecters" — e nome de produto quase sempre tem.
    const semAcento = corpo.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const resp = await axios.get('https://api.callmebot.com/whatsapp.php', {
      params: { phone: CALLMEBOT_PHONE, text: semAcento, apikey: CALLMEBOT_APIKEY },
    });
    if (typeof resp.data === 'string' && resp.data.includes('Error')) {
      console.log(`Aviso: CallMeBot recusou a mensagem: ${resp.data}`);
    } else {
      console.log(`Alerta enviado via CallMeBot (${risco.length} SKU(s) em risco).`);
      return;
    }
  }

  if (ZAPI_INSTANCE_URL && WHATSAPP_DESTINO) {
    await axios.post(`${ZAPI_INSTANCE_URL}/send-text`, {
      phone: WHATSAPP_DESTINO,
      message: corpo,
    });
    console.log(`Alerta enviado via Z-API (${risco.length} SKU(s) em risco).`);
    return;
  }

  if (GMAIL_USER && GMAIL_APP_PASSWORD && EMAIL_DESTINO) {
    const transporte = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });

    await transporte.sendMail({
      from: GMAIL_USER,
      to: EMAIL_DESTINO,
      subject: `Risco de furo de estoque - ${risco.length} SKU(s)`,
      text: corpo,
    });
    console.log(`Alerta enviado por e-mail pra ${EMAIL_DESTINO} (${risco.length} SKU(s) em risco).`);
    return;
  }

  console.log(`${risco.length} SKU(s) em risco de furo, mas nenhum canal de alerta configurado (CallMeBot, Z-API ou Gmail).`);
}

// ===== 7. SALVAR RESULTADO PRO PAINEL (arquivo local, commitado pelo Actions) =====
function salvarResultadoLocal({ totalSkusML, divergencias, semSkuNoBling }) {
  const corretos = totalSkusML - divergencias.length - semSkuNoBling.length;

  const resultado = {
    atualizadoEm: new Date().toISOString(),
    totalSkus: totalSkusML,
    corretos,
    totalDivergentes: divergencias.length,
    // [{ sku, qtdBling, qtdML, diferenca, corrigido?, corrigidoDetalhe? }] —
    // "itens" (item_id do ML) é só uso interno, não vai pro painel.
    divergencias: divergencias.map(({ itens, ...resto }) => resto),
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

  await corrigirEstoqueML(mlToken, divergencias);
  await enviarAlertaRisco(divergencias);
  salvarResultadoLocal({ totalSkusML, divergencias, semSkuNoBling });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Erro na verificação de estoque:', err.response?.data || err.message);
    process.exit(1);
  });
}
