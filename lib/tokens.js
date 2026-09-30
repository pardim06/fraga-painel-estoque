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
const { aguardar } = require('./bling-http');
const { enviarNotificacao } = require('./notificar');

const ENV_PATH = path.join(__dirname, '..', '.env');

async function salvarNovoRefreshToken(nome, valor) {
  const token = process.env.GH_PAT;
  const repo = process.env.GITHUB_REPOSITORY;

  if (token && repo) {
    // Bling/ML já invalidaram o valor antigo assim que emitiram esse — se
    // não persistir, toda execução seguinte quebra com "invalid_grant" até
    // alguém perceber (já aconteceu: um 503 pontual da API do GitHub aqui
    // deixou o sistema fora do ar por 16h sem nenhum aviso). Tenta de novo
    // algumas vezes (503 costuma ser transitório) e, se mesmo assim falhar,
    // avisa pelo canal de alerta em vez de só logar.
    const TENTATIVAS = 3;
    for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
      try {
        await atualizarSecretGithub(nome, valor, token, repo);
        return;
      } catch (err) {
        const status = err.response?.status || err.message;
        if (tentativa < TENTATIVAS) {
          console.log(`Aviso: falha ao atualizar o secret ${nome} no GitHub (${status}), tentativa ${tentativa}/${TENTATIVAS} — tentando de novo...`);
          await aguardar(2000 * tentativa);
          continue;
        }
        console.log(`Aviso: falha ao atualizar o secret ${nome} no GitHub após ${TENTATIVAS} tentativas (${status}). Copie manualmente se necessário: ${valor}`);
        await enviarNotificacao(
          `*ATENCAO - falha ao salvar ${nome} no GitHub*\n\nO token girou mas nao foi possivel salvar o novo valor no repositorio (erro ${status} apos ${TENTATIVAS} tentativas). Sem isso, o sistema para de funcionar no proximo ciclo.\n\nAtualize manualmente o secret ${nome} com:\n${valor}`,
          `URGENTE - ${nome} precisa ser atualizado manualmente`
        );
      }
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
    'https://api.bling.com.br/Api/v3/oauth/token',
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
