// lib/lojas-ecommerce.js
//
// Lojas de e-commerce cadastradas no Bling — Mercado Livre e Bagy/site.
// Compartilhado entre scripts/lista-compras.js e scripts/mercadolider.js.
// Exclui loja física (id 205187092) e pedidos sem loja associada. IDs
// identificados por inferência (loja física sempre tem "vendedor" no
// pedido, e-commerce nunca tem) — confira em Vendas > Pedidos no Bling
// se algum dia os números não baterem.

const LOJAS_ECOMMERCE = new Set(['204966737', '205655926']);

// Nome de exibição de cada loja — confirmado pelo formato de numeroLoja do
// pedido (204966737 tem numeroLoja longo e numérico, padrão de ID de pedido
// do Mercado Livre; 205655926 tem formato alfanumérico curto, padrão Bagy).
const CANAL_POR_LOJA = {
  204966737: 'Mercado Livre',
  205655926: 'Bagy',
};

module.exports = { LOJAS_ECOMMERCE, CANAL_POR_LOJA };
