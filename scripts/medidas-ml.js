// scripts/medidas-ml.js
//
// Puxa as medidas de envio (comprimento, largura, altura, peso) de todos os
// anúncios ativos no Mercado Livre. Sem isso certo, o ML calcula o frete com
// medida padrão da categoria — que raramente bate com o produto real — e
// isso sai caro (frete subsidiado errado) ou passa credibilidade ruim pro
// comprador. Roda 1x/dia (encadeado no workflow de lista de compras) —
// medida de produto não muda de hora em hora.

require('dotenv').config();
const axios = require('axios');
const { getMLAccessToken } = require('../lib/tokens');
const { publicarDados } = require('../lib/supabase-publicar');

const ML_SELLER_ID = process.env.ML_SELLER_ID;

function aguardar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buscarTodosAtivos(accessToken) {
  const ids = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const resp = await axios.get(`https://api.mercadolibre.com/users/${ML_SELLER_ID}/items/search`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { offset, limit, status: 'active' },
    });

    const resultados = resp.data.results || [];
    if (resultados.length === 0) break;
    ids.push(...resultados);
    offset += limit;
  }

  return ids;
}

// item.shipping.dimensions vem como "LxAxC,peso" em cm/gramas quando o
// vendedor declarou medida própria do pacote — é o formato documentado pela
// própria ML, por isso confiamos na unidade sem precisar normalizar nada.
function parsearDimensionsString(texto) {
  if (!texto) return null;
  const match = /^(\d+)x(\d+)x(\d+),(\d+)$/.exec(texto.trim());
  if (!match) return null;
  const [, comprimento, largura, altura, peso] = match;
  return {
    comprimentoCm: Number(comprimento),
    larguraCm: Number(largura),
    alturaCm: Number(altura),
    pesoG: Number(peso),
  };
}

// Fallback: algumas categorias expõem como atributos PACKAGE_* em vez de
// shipping.dimensions — aqui a unidade vem no próprio value_struct, então
// mostramos como o ML relatou em vez de converter às cegas.
function extrairAtributosPackage(attributes) {
  if (!Array.isArray(attributes)) return null;
  const porId = {};
  for (const attr of attributes) {
    if (['PACKAGE_LENGTH', 'PACKAGE_WIDTH', 'PACKAGE_HEIGHT', 'PACKAGE_WEIGHT'].includes(attr.id)) {
      const valor = attr.value_struct
        ? `${attr.value_struct.number ?? attr.value_struct.value}${attr.value_struct.unit || ''}`
        : attr.value_name;
      porId[attr.id] = valor;
    }
  }
  if (Object.keys(porId).length === 0) return null;
  return {
    comprimento: porId.PACKAGE_LENGTH || null,
    largura: porId.PACKAGE_WIDTH || null,
    altura: porId.PACKAGE_HEIGHT || null,
    peso: porId.PACKAGE_WEIGHT || null,
  };
}

async function buscarMedidas(accessToken, itemIds) {
  const itens = [];

  for (let i = 0; i < itemIds.length; i += 20) {
    const lote = itemIds.slice(i, i + 20);
    const resp = await axios.get('https://api.mercadolibre.com/items', {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { ids: lote.join(','), attributes: 'id,title,seller_custom_field,permalink,attributes,shipping' },
    });

    for (const entry of resp.data) {
      if (entry.code !== 200) continue;
      const item = entry.body;
      const sku =
        item.seller_custom_field ||
        item.attributes?.find((a) => a.id === 'SELLER_SKU')?.value_name ||
        null;

      const porDimensions = parsearDimensionsString(item.shipping?.dimensions);
      const porAtributos = porDimensions ? null : extrairAtributosPackage(item.attributes);

      const semMedidas = !porDimensions && !porAtributos;
      const zerado =
        !!porDimensions &&
        (porDimensions.comprimentoCm === 0 ||
          porDimensions.larguraCm === 0 ||
          porDimensions.alturaCm === 0 ||
          porDimensions.pesoG === 0);

      itens.push({
        itemId: item.id,
        sku,
        titulo: item.title,
        link: item.permalink,
        medidas: porDimensions
          ? {
              comprimento: `${porDimensions.comprimentoCm} cm`,
              largura: `${porDimensions.larguraCm} cm`,
              altura: `${porDimensions.alturaCm} cm`,
              peso: `${porDimensions.pesoG} g`,
            }
          : porAtributos,
        suspeito: semMedidas || zerado,
        motivoSuspeita: semMedidas ? 'sem medida cadastrada' : zerado ? 'alguma medida zerada' : null,
      });
    }

    await aguardar(150); // throttle leve pra não estourar limite da API
  }

  return itens;
}

async function main() {
  const token = await getMLAccessToken();
  const itemIds = await buscarTodosAtivos(token);

  // Diagnostico temporario: dump completo (sem projecao de campos) do
  // primeiro item, pra confirmar o formato real que a conta devolve antes
  // de confiar na extracao de shipping.dimensions / attributes PACKAGE_*.
  if (itemIds[0]) {
    const respCompleto = await axios.get(`https://api.mercadolibre.com/items/${itemIds[0]}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log('DIAGNOSTICO item completo:', JSON.stringify({
      id: respCompleto.data.id,
      shipping: respCompleto.data.shipping,
      attributes: (respCompleto.data.attributes || []).filter((a) =>
        /PACKAGE|WEIGHT|LENGTH|WIDTH|HEIGHT|DIMENS/i.test(a.id) || /PACKAGE|WEIGHT|LENGTH|WIDTH|HEIGHT|DIMENS/i.test(a.name || '')
      ),
    }));
  }

  const itens = await buscarMedidas(token, itemIds);

  // Suspeitos primeiro — é o que o usuário quer ver de cara.
  itens.sort((a, b) => (a.suspeito === b.suspeito ? 0 : a.suspeito ? -1 : 1));

  const totalSuspeitos = itens.filter((i) => i.suspeito).length;

  const resultado = {
    atualizadoEm: new Date().toISOString(),
    totalItens: itens.length,
    totalSuspeitos,
    itens,
  };

  await publicarDados('medidas-ml.json', resultado);
  console.log(`Medidas publicadas: ${itens.length} anúncio(s), ${totalSuspeitos} suspeito(s) (sem medida ou medida zerada).`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Erro ao verificar medidas dos anúncios:', err.response?.data || err.message);
    process.exit(1);
  });
}
