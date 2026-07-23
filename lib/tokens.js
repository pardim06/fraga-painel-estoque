// lib/tokens.js
//
// Autenticação e persistência de refresh_token compartilhadas entre os
// scripts (verificador-estoque-ml-bling.js e verificar-perguntas.js).
// Bling e ML giram o refresh_token a cada uso — local (sem GH_PAT/
// GITHUB_REPOSITORY) grava direto no .env; no GitHub Actions atualiza o
// Secret do repositório via API (precisa do secret GH_PAT).

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sodium = require('libsodium-wrappers');

const ENV_PATH = path.join(__dirname, '..', '.env');

async function salvarNovoRefreshToken(nome, valor) {
  const token = process.env.GH_PAT;
  const repo = process.env.GITHUB_REPOSITORY;

  if (token && repo) {
    try {
      await atualizarSecretGithub(nome, valor, token, repo);
    } catch (err) {
      // Nunca deixa uma falha ao persistir o secret derrubar a execução em si.
      console.log(`Aviso: falha ao atualizar o secret ${nome} no GitHub (${err.response?.status || err.message}). Copie manualmente se necessário: ${valor}`);
    }
    return;
  }

  if (!fs.existsSync(ENV_PATH)) {
    console.log(`Aviso: .env não encontrado — não foi possível persistir o novo ${nome}. Copie manualmente: ${valor}`);
    return;
  }

  let conteudo = fs.readFileSync(ENV_PATH, 'utf8');
  const linha = `${nome}=${valor}`;
  const regex = new RegExp(`^${nome}=.*$`, 'm');
  conteudo = regex.test(conteudo) ? conteudo.replace(regex, linha) : conteudo + `\n${linha}\n`;
  fs.writeFileSync(ENV_PATH, conteudo);
  console.log(`.env atualizado localmente: ${nome}`);
}

async function atualizarSecretGithub(nome, valor, token, repo) {
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

async function getBlingAccessToken() {
  const resp = await axios.post(
    'https://www.bling.com.br/Api/v3/oauth/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: process.env.BLING_REFRESH_TOKEN,
    }),
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${process.env.BLING_CLIENT_ID}:${process.env.BLING_CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  if (resp.data.refresh_token && resp.data.refresh_token !== process.env.BLING_REFRESH_TOKEN) {
    await salvarNovoRefreshToken('BLING_REFRESH_TOKEN', resp.data.refresh_token);
  }

  return resp.data.access_token;
}

async function getMLAccessToken() {
  const resp = await axios.post(
    'https://api.mercadolibre.com/oauth/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ML_CLIENT_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      refresh_token: process.env.ML_REFRESH_TOKEN,
    })
  );

  if (resp.data.refresh_token && resp.data.refresh_token !== process.env.ML_REFRESH_TOKEN) {
    await salvarNovoRefreshToken('ML_REFRESH_TOKEN', resp.data.refresh_token);
  }

  return resp.data.access_token;
}

module.exports = { salvarNovoRefreshToken, getBlingAccessToken, getMLAccessToken };
