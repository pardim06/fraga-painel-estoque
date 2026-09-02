// scripts/obter-token.js
//
// Uso único, local, pra trocar o "code" da autorização OAuth pelo refresh_token.
// node scripts/obter-token.js ml <code>
// node scripts/obter-token.js bling <code>
// node scripts/obter-token.js shopee-url            (gera o link de autorização)
// node scripts/obter-token.js shopee <code> <shopId> (troca o code pelos tokens)
//
// Atualiza o .env automaticamente com o resultado.

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');
const { getAuthorizationUrl, exchangeCodeForToken } = require('../lib/shopee');

const ML_REDIRECT_URI = 'https://oauth.pstmn.io/v1/callback';
const BLING_REDIRECT_URI = 'http://localhost:3000/callback'; // redirect_uri cadastrado no app do Bling
const SHOPEE_REDIRECT_URI = process.env.SHOPEE_REDIRECT_URI || 'https://oauth.pstmn.io/v1/callback';
const ENV_PATH = path.join(__dirname, '..', '.env');

function atualizarEnvLocal(chave, valor) {
  let conteudo = fs.readFileSync(ENV_PATH, 'utf8');
  const linha = `${chave}=${valor}`;
  const regex = new RegExp(`^${chave}=.*$`, 'm');
  conteudo = regex.test(conteudo) ? conteudo.replace(regex, linha) : conteudo + `\n${linha}\n`;
  fs.writeFileSync(ENV_PATH, conteudo);
  console.log(`.env atualizado: ${chave}`);
}

async function trocarML(code) {
  const resp = await axios.post(
    'https://api.mercadolibre.com/oauth/token',
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.ML_CLIENT_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      code,
      redirect_uri: ML_REDIRECT_URI,
    })
  );

  const { access_token, refresh_token, user_id } = resp.data;
  console.log('ML access_token:', access_token);
  console.log('ML refresh_token:', refresh_token);
  console.log('ML seller/user_id:', user_id);

  atualizarEnvLocal('ML_REFRESH_TOKEN', refresh_token);
  if (user_id) atualizarEnvLocal('ML_SELLER_ID', user_id);
}

async function trocarBling(code) {
  const resp = await axios.post(
    'https://api.bling.com.br/Api/v3/oauth/token',
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: BLING_REDIRECT_URI,
    }),
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${process.env.BLING_CLIENT_ID}:${process.env.BLING_CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  const { access_token, refresh_token } = resp.data;
  console.log('Bling access_token:', access_token);
  console.log('Bling refresh_token:', refresh_token);

  atualizarEnvLocal('BLING_REFRESH_TOKEN', refresh_token);
}

function gerarUrlShopee() {
  const { SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY } = process.env;
  if (!SHOPEE_PARTNER_ID || !SHOPEE_PARTNER_KEY) {
    console.error('Configure SHOPEE_PARTNER_ID e SHOPEE_PARTNER_KEY no .env antes.');
    process.exit(1);
  }
  const url = getAuthorizationUrl(SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, SHOPEE_REDIRECT_URI);
  console.log('Abra essa URL, faça login na loja Shopee e autorize:');
  console.log(url);
  console.log('\nDepois de autorizar, o redirect vai trazer ?code=...&shop_id=... na URL — copie os dois.');
}

async function trocarShopee(code, shopId) {
  const { SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY } = process.env;
  if (!SHOPEE_PARTNER_ID || !SHOPEE_PARTNER_KEY) {
    console.error('Configure SHOPEE_PARTNER_ID e SHOPEE_PARTNER_KEY no .env antes.');
    process.exit(1);
  }
  if (!shopId) {
    console.error('Uso: node scripts/obter-token.js shopee <code> <shopId>');
    process.exit(1);
  }

  const resultado = await exchangeCodeForToken(SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, code, shopId);
  console.log('Resposta da Shopee:', JSON.stringify(resultado, null, 2));

  if (resultado.access_token) {
    atualizarEnvLocal('SHOPEE_ACCESS_TOKEN', resultado.access_token);
    atualizarEnvLocal('SHOPEE_REFRESH_TOKEN', resultado.refresh_token);
    atualizarEnvLocal('SHOPEE_SHOP_ID', shopId);
  }
}

async function main() {
  const [, , servico, arg1, arg2] = process.argv;
  if (!servico) {
    console.error('Uso: node scripts/obter-token.js <ml|bling> <code>  |  shopee-url  |  shopee <code> <shopId>');
    process.exit(1);
  }

  if (servico === 'ml') await trocarML(arg1);
  else if (servico === 'bling') await trocarBling(arg1);
  else if (servico === 'shopee-url') gerarUrlShopee();
  else if (servico === 'shopee') await trocarShopee(arg1, arg2);
  else {
    console.error('Serviço inválido, use "ml", "bling", "shopee-url" ou "shopee".');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Erro ao trocar código:', err.response?.data || err.message);
  process.exit(1);
});
