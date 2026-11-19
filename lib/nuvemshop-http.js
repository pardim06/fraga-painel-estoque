// lib/nuvemshop-http.js
//
// Cliente HTTP compartilhado pra API da Nuvemshop — mesma ideia do
// bling-http.js: espera entre chamadas e tenta de novo com backoff se tomar
// 429. User-Agent genérico (sem e-mail pessoal) é exigido em toda chamada.

const axios = require('axios');

const NUVEMSHOP_ACCESS_TOKEN = process.env.NUVEMSHOP_ACCESS_TOKEN;
const NUVEMSHOP_STORE_ID = process.env.NUVEMSHOP_STORE_ID;
const BASE_URL = `https://api.nuvemshop.com.br/v1/${NUVEMSHOP_STORE_ID}`;
const USER_AGENT = 'Painel Estoque Fraga Bike Shop (app interno)';

const aguardar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function headers() {
  return { Authorization: `Bearer ${NUVEMSHOP_ACCESS_TOKEN}`, 'User-Agent': USER_AGENT };
}

async function nuvemshopGet(path, config = {}, tentativa = 1) {
  await aguardar(300);
  try {
    return await axios.get(`${BASE_URL}${path}`, { ...config, headers: headers() });
  } catch (err) {
    if (err.response?.status === 429 && tentativa <= 4) {
      await aguardar(1000 * tentativa);
      return nuvemshopGet(path, config, tentativa + 1);
    }
    throw err;
  }
}

async function nuvemshopPut(path, body, config = {}, tentativa = 1) {
  await aguardar(300);
  try {
    return await axios.put(`${BASE_URL}${path}`, body, { ...config, headers: headers() });
  } catch (err) {
    if (err.response?.status === 429 && tentativa <= 4) {
      await aguardar(1000 * tentativa);
      return nuvemshopPut(path, body, config, tentativa + 1);
    }
    throw err;
  }
}

module.exports = { aguardar, nuvemshopGet, nuvemshopPut };
