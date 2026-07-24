// lib/bling-http.js
//
// Bling limita a 3 requisições/segundo. Espera entre chamadas e tenta de novo
// (com backoff) se ainda assim tomar 429 — usado por qualquer script que
// bata na API do Bling repetidamente (verificador de estoque, lista de
// compras etc.).

const axios = require('axios');

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

module.exports = { aguardar, blingGet };
