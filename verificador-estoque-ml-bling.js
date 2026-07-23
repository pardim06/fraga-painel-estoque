// verificador-estoque-ml-bling.js
//
// Verifica divergência entre o estoque do Bling e o estoque publicado no
// Mercado Livre, e (opcionalmente) avisa via WhatsApp (Z-API) quando encontrar
// diferença. Roda via GitHub Actions (cron a cada hora) — veja
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
const sodium = require('libsodium-wrappers');

// ===== CONFIG (variáveis de ambiente / GitHub Secrets) =====
const OUTPUT_PATH = path.join(__dirname, 'resultado-verificacao.json');

const BLING_CLIENT_ID = process.env.BLING_CLIENT_ID;
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET;
const BLING_REFRESH_TOKEN = process.env.BLING_REFRESH_TOKEN;

const ML_CLIENT_ID = process.env.ML_CLIENT_ID;
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const ML_REFRESH_TOKEN = process.env.ML_REFRESH_TOKEN;
const ML_SELLER_ID = process.env.ML_SELLER_ID;

// Opcionais — se não configurados, o envio de WhatsApp é simplesmente pulado.
const ZAPI_INSTANCE_URL = process.env.ZAPI_INSTANCE_URL; // ex: https://api.z-api.io/instances/SEU_ID/token/SEU_TOKEN
const WHATSAPP_DESTINO = process.env.WHATSAPP_DESTINO; // seu número, ex: 5531999999999

const TOLERANCIA = 0; // diferença mínima pra considerar divergência (0 = qualquer diferença já dispara)

// ===== 0. ATUALIZAÇÃO AUTOMÁTICA DE SECRETS (Bling e ML giram o refresh_token a cada uso) =====
// Exige um secret GH_PAT (Personal Access Token com permissão de "Secrets" no repo).
// Sem ele, o script funciona mas o novo refresh_token não é persistido — a próxima
// execução vai falhar quando o token antigo já tiver sido invalidado.
async function atualizarSecretGithub(nome, valor) {
  const token = process.env.GH_PAT;
  const repo = process.env.GITHUB_REPOSITORY; // preenchido automaticamente pelo GitHub Actions

  if (!token || !repo) {
    console.log(`Aviso: GH_PAT não configurado — não foi possível atualizar o secret ${nome} automaticamente. A próxima execução pode falhar.`);
    return;
  }

  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };

  const { data: chavePublica } = await axios.get(
    `https://api.github.com/repos/${repo}/actions/secrets/public-key`,
    { headers }
  );

  await sodium.ready;
  const chaveBytes = sodium.from_base64(chavePublica.key, sodium.base64_variants.ORIGINAL);
  const valorBytes = sodium.from_string(valor);
  const criptografado = sodium.crypto_box_seal(valorBytes, chaveBytes);
  const encryptedValue = sodium.to_base64(criptografado, sodium.base64_variants.ORIGINAL);

  await axios.put(
    `https://api.github.com/repos/${repo}/actions/secrets/${nome}`,
    { encrypted_value: encryptedValue, key_id: chavePublica.key_id },
    { headers }
  );

  console.log(`Secret ${nome} atualizado no GitHub.`);
}

// ===== 1. AUTENTICAÇÃO BLING =====
async function getBlingAccessToken() {
  const resp = await axios.post(
    'https://www.bling.com.br/Api/v3/oauth/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: BLING_REFRESH_TOKEN,
    }),
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  if (resp.data.refresh_token && resp.data.refresh_token !== BLING_REFRESH_TOKEN) {
    await atualizarSecretGithub('BLING_REFRESH_TOKEN', resp.data.refresh_token);
  }

  return resp.data.access_token;
}

// ===== 2. ESTOQUE NO BLING =====
// Retorna um mapa { sku: quantidade }
async function getEstoqueBling(accessToken) {
  const estoques = {};
  let pagina = 1;

  while (true) {
    const resp = await axios.get('https://www.bling.com.br/Api/v3/estoques/saldos', {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { pagina, limite: 100 },
    });

    const dados = resp.data.data || [];
    if (dados.length === 0) break;

    for (const item of dados) {
      // ajuste o campo conforme o retorno real da sua conta
      const sku = item.produto?.codigo;
      const saldo = item.saldoFisicoTotal ?? item.saldoVirtualTotal;
      if (sku) estoques[sku] = saldo;
    }

    pagina++;
  }

  return estoques;
}

// ===== 3. AUTENTICAÇÃO MERCADO LIVRE =====
async function getMLAccessToken() {
  const resp = await axios.post(
    'https://api.mercadolibre.com/oauth/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: ML_REFRESH_TOKEN,
    })
  );

  if (resp.data.refresh_token && resp.data.refresh_token !== ML_REFRESH_TOKEN) {
    await atualizarSecretGithub('ML_REFRESH_TOKEN', resp.data.refresh_token);
  }

  return resp.data.access_token;
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
        if (sku) estoques[sku] = item.available_quantity;
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
    const qtdBling = estoqueBling[sku];
    const qtdML = estoqueML[sku];

    if (qtdBling === undefined) {
      semSkuNoBling.push(sku);
      continue;
    }

    const diferenca = Math.abs(qtdBling - qtdML);
    if (diferenca > TOLERANCIA) {
      divergencias.push({ sku, qtdBling, qtdML, diferenca });
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
    mensagem += `SKU ${d.sku}: Bling ${d.qtdBling} | ML ${d.qtdML} | diferenca ${d.diferenca}\n`;
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
