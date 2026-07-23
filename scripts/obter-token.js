// scripts/obter-token.js
//
// Uso único, local, pra trocar o "code" da autorização OAuth pelo refresh_token.
// node scripts/obter-token.js ml <code>
// node scripts/obter-token.js bling <code>
//
// Atualiza o .env automaticamente com o resultado.

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');

const ML_REDIRECT_URI = 'https://oauth.pstmn.io/v1/callback';
const BLING_REDIRECT_URI = 'http://localhost:3000/callback'; // redirect_uri cadastrado no app do Bling
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
    'https://www.bling.com.br/Api/v3/oauth/token',
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

async function main() {
  const [, , servico, code] = process.argv;
  if (!servico || !code) {
    console.error('Uso: node scripts/obter-token.js <ml|bling> <code>');
    process.exit(1);
  }

  if (servico === 'ml') await trocarML(code);
  else if (servico === 'bling') await trocarBling(code);
  else {
    console.error('Serviço inválido, use "ml" ou "bling".');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Erro ao trocar código:', err.response?.data || err.message);
  process.exit(1);
});
