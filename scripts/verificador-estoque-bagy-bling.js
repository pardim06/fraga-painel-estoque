// scripts/verificador-estoque-bagy-bling.js
//
// Verifica divergência entre o estoque do Bling e o estoque publicado na
// loja Bagy (fragabikeshop.com.br). Roda via GitHub Actions — veja
// .github/workflows/bagy.yml.
//
// Diferente do verificador-estoque-ml-bling.js, esse aqui é SÓ LEITURA:
// não corrige nada automaticamente na Bagy nem manda alerta de risco.
// Objetivo por enquanto é validar se a comparação bate com a realidade
// antes de considerar automatizar a correção, como já existe pro ML.

const fs = require('fs');
const path = require('path');
require('dotenv').config(); // no-op em produção: GitHub Actions já injeta as env vars diretamente
const axios = require('axios');
const { getBlingAccessToken } = require('../lib/tokens');
const { getEstoqueBling } = require('../lib/bling-estoque');

const OUTPUT_PATH = path.join(__dirname, '..', 'resultado-bagy.json');
const BAGY_ACCESS_TOKEN = process.env.BAGY_ACCESS_TOKEN;

// ===== ESTOQUE PUBLICADO NA BAGY =====
// Retorna um mapa { sku: { saldo, nome } }. O estoque de verdade mora na
// variação (variations[].balance), não no produto — mesmo produto sem
// variação visível no site aparece aqui como 1 variação única (confirmado
// testando contra a loja real). sku/external_id/reference da variação são
// sempre iguais entre si e batem com o "codigo" do Bling.
async function getEstoqueBagy() {
  const estoques = {};
  let page = 1;

  while (true) {
    const resp = await axios.get('https://api.dooca.store/products', {
      headers: { Authorization: `Bearer ${BAGY_ACCESS_TOKEN}` },
      params: { limit: 100, page },
    });

    const produtos = resp.data.data || [];
    if (produtos.length === 0) break;

    for (const produto of produtos) {
      if (!produto.active) continue;

      for (const v of produto.variations || []) {
        if (v.active === false) continue;
        const sku = v.sku || v.external_id || v.reference;
        if (!sku) continue;

        const saldo = (v.balance || 0) - (v.reserved_balance || 0);
        estoques[sku] = { saldo, nome: produto.name };
      }
    }

    const totalPaginas = resp.data.meta?.last_page || page;
    if (page >= totalPaginas) break;
    page++;
  }

  return estoques;
}

// ===== COMPARAÇÃO =====
function compararEstoques(estoqueBling, estoqueBagy) {
  const divergencias = [];
  const semSkuNoBling = [];

  for (const sku in estoqueBagy) {
    const bling = estoqueBling[sku];
    const bagy = estoqueBagy[sku];

    if (bling === undefined) {
      semSkuNoBling.push(sku);
      continue;
    }

    // Sinal importa: positivo = Bling tem mais que a Bagy (só perde exposição
    // de venda); negativo = Bling tem menos que a Bagy publicada (risco real
    // de vender sem estoque).
    const diferenca = bling.saldo - bagy.saldo;
    if (diferenca !== 0) {
      divergencias.push({
        sku,
        nome: bling.nome || bagy.nome,
        qtdBling: bling.saldo,
        qtdBagy: bagy.saldo,
        diferenca,
      });
    }
  }

  return { divergencias, semSkuNoBling };
}

// ===== SALVAR RESULTADO PRO PAINEL =====
function salvarResultadoLocal({ totalSkusBagy, divergencias, semSkuNoBling }) {
  const totalComparavel = totalSkusBagy - semSkuNoBling.length;
  const corretos = totalComparavel - divergencias.length;

  const resultado = {
    atualizadoEm: new Date().toISOString(),
    totalSkus: totalComparavel,
    corretos,
    totalDivergentes: divergencias.length,
    divergencias,
    semSkuNoBling,
    observacao: 'Comparação só leitura — nenhuma correção automática é feita na Bagy ainda.',
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(resultado, null, 2));
  console.log(`Resultado salvo em ${OUTPUT_PATH}`);
}

// ===== EXECUÇÃO =====
async function main() {
  if (!BAGY_ACCESS_TOKEN) {
    throw new Error('BAGY_ACCESS_TOKEN não configurado (.env local ou GitHub Secret).');
  }

  const blingToken = await getBlingAccessToken();
  const estoqueBling = await getEstoqueBling(blingToken);
  const estoqueBagy = await getEstoqueBagy();

  const { divergencias, semSkuNoBling } = compararEstoques(estoqueBling, estoqueBagy);
  const totalSkusBagy = Object.keys(estoqueBagy).length;

  console.log(`Verificação Bagy x Bling concluída: ${divergencias.length} divergências encontradas.`);
  if (semSkuNoBling.length > 0) {
    console.log(`Aviso: ${semSkuNoBling.length} SKUs da Bagy não foram encontrados no Bling (verifique cadastro).`);
  }

  salvarResultadoLocal({ totalSkusBagy, divergencias, semSkuNoBling });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Erro na verificação de estoque Bagy x Bling:', err.response?.data || err.message);
    process.exit(1);
  });
}
