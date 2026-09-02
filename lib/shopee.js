// lib/shopee.js
//
// Cliente mínimo pra API v2 da Shopee (Open Platform). Toda chamada exige
// uma assinatura HMAC-SHA256 — a Shopee não usa Bearer token simples como
// ML/Bling, o partner_key assina cada requisição junto com o path e o
// timestamp (e access_token + shop_id, nas chamadas de loja já autorizada).
//
// Fluxo de autorização (uso único, local, via scripts/obter-token-shopee.js):
// 1. Gera a URL de autorização (getAuthorizationUrl) e abre no navegador logado na loja.
// 2. Shopee redireciona pra SHOPEE_REDIRECT_URI com ?code=...&shop_id=...
// 3. Troca o code pelo access_token/refresh_token (exchangeCodeForToken).
// Depois disso, o refresh_token gira a cada uso, igual ML/Bling (getAccessToken).

const crypto = require('crypto');
const axios = require('axios');

const BASE_URL = 'https://partner.shopeemobile.com';

function timestamp() {
  return Math.floor(Date.now() / 1000);
}

// Assinatura pra chamadas SEM loja autorizada ainda (ex: gerar link de auth).
function assinarPublico(partnerId, partnerKey, path, ts) {
  const baseString = `${partnerId}${path}${ts}`;
  return crypto.createHmac('sha256', partnerKey).update(baseString).digest('hex');
}

// Assinatura pra chamadas COM loja autorizada (a maioria das APIs de produto/estoque).
function assinarLoja(partnerId, partnerKey, path, ts, accessToken, shopId) {
  const baseString = `${partnerId}${path}${ts}${accessToken}${shopId}`;
  return crypto.createHmac('sha256', partnerKey).update(baseString).digest('hex');
}

function getAuthorizationUrl(partnerId, partnerKey, redirectUri) {
  const path = '/api/v2/shop/auth_partner';
  const ts = timestamp();
  const sign = assinarPublico(partnerId, partnerKey, path, ts);
  const params = new URLSearchParams({
    partner_id: partnerId,
    timestamp: ts,
    sign,
    redirect: redirectUri,
  });
  return `${BASE_URL}${path}?${params.toString()}`;
}

async function exchangeCodeForToken(partnerId, partnerKey, code, shopId) {
  const path = '/api/v2/auth/token/get';
  const ts = timestamp();
  const sign = assinarPublico(partnerId, partnerKey, path, ts);

  const resp = await axios.post(
    `${BASE_URL}${path}?partner_id=${partnerId}&timestamp=${ts}&sign=${sign}`,
    { code, shop_id: Number(shopId), partner_id: Number(partnerId) }
  );
  return resp.data; // { access_token, refresh_token, expire_in, shop_id, ... }
}

async function refreshAccessToken(partnerId, partnerKey, refreshToken, shopId) {
  const path = '/api/v2/auth/access_token/get';
  const ts = timestamp();
  const sign = assinarPublico(partnerId, partnerKey, path, ts);

  const resp = await axios.post(
    `${BASE_URL}${path}?partner_id=${partnerId}&timestamp=${ts}&sign=${sign}`,
    { refresh_token: refreshToken, shop_id: Number(shopId), partner_id: Number(partnerId) }
  );
  return resp.data; // { access_token, refresh_token, expire_in, ... }
}

// GET autenticado numa loja já autorizada (produtos, estoque etc.)
async function shopeeGet(partnerId, partnerKey, accessToken, shopId, path, params = {}) {
  const ts = timestamp();
  const sign = assinarLoja(partnerId, partnerKey, path, ts, accessToken, shopId);

  const resp = await axios.get(`${BASE_URL}${path}`, {
    params: {
      ...params,
      partner_id: partnerId,
      timestamp: ts,
      sign,
      access_token: accessToken,
      shop_id: shopId,
    },
  });
  return resp.data;
}

module.exports = { getAuthorizationUrl, exchangeCodeForToken, refreshAccessToken, shopeeGet };
