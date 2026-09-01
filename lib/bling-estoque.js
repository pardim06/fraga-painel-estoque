// lib/bling-estoque.js
//
// Estoque do Bling, compartilhado entre os verificadores (ML e Bagy) — a
// mesma consulta serve pra comparar contra qualquer canal de venda.

const { blingGet } = require('./bling-http');

// Depósito "1 - SITE / MERCADO LIVRE" — só o estoque desse depósito deve ser
// comparado com os canais online (os outros são lojas físicas, reserva, eventos etc.).
const BLING_DEPOSITO_ID = process.env.BLING_DEPOSITO_ID || '14887750294';

// Retorna um mapa { sku: { saldo, nome } }
async function getEstoqueBling(accessToken) {
  // 1. lista todos os produtos ativos, exceto os "pai" com variações (formato "V"):
  // { id -> {codigo, nome} }. Um produto pai não tem saldo próprio — quem carrega
  // o estoque de verdade são as variações filhas, que já aparecem nessa mesma
  // listagem como itens separados (formato "S"). Kits (formato "E") têm saldo
  // próprio normalmente e entram na comparação como qualquer produto simples.
  const infoPorId = {};
  let pagina = 1;

  while (true) {
    const resp = await blingGet('https://api.bling.com.br/Api/v3/produtos', {
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
    const resp = await blingGet('https://api.bling.com.br/Api/v3/estoques/saldos', {
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

module.exports = { getEstoqueBling, BLING_DEPOSITO_ID };
