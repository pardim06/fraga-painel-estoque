// verificador-estoque-ml-bling.js
//
// Verifica divergência entre o estoque do Bling e o estoque publicado no
// Mercado Livre, e (opcionalmente) avisa via WhatsApp (Z-API) quando encontrar
// diferença. Roda via GitHub Actions (cron a cada 15 minutos) — veja
// .github/workflows/verificar-estoque.yml.
//
// IMPORTANTE: os nomes de campos do Bling (produto.codigo, saldoFisicoTotal)
// e do ML (seller_custom_field) podem variar conforme sua configuração de
// catálogo. Confirme contra o retorno real da sua conta antes de colocar em
// produção — a Bling e o ML atualizam a API de vez em quando.

const fs = require('fs');
const path = require('path');
require('dotenv').config(); // no-op em produção: GitHub Actions já injeta as env vars diretamente
const axios = require('axios');
const { getBlingAccessToken, getMLAccessToken } = require('./lib/tokens');
const { aguardar } = require('./lib/bling-http');
const { getEstoqueBling } = require('./lib/bling-estoque');
const { enviarNotificacao } = require('./lib/notificar');

// ===== CONFIG (variáveis de ambiente / GitHub Secrets) =====
const OUTPUT_PATH = path.join(__dirname, 'resultado-verificacao.json');
const HISTORICO_PATH = path.join(__dirname, 'historico-correcoes.json');
const HISTORICO_MAX = 300; // mantém só as correções mais recentes, pra não crescer sem limite
const HISTORICO_MENSAL_PATH = path.join(__dirname, 'historico-mensal.json');

const ML_SELLER_ID = process.env.ML_SELLER_ID;

const TOLERANCIA = 0; // diferença mínima pra considerar divergência (0 = qualquer diferença já dispara)

// ===== 4. ESTOQUE PUBLICADO NO ML =====
// Retorna um mapa { sku: quantidade_disponivel }
async function getEstoqueML(accessToken) {
  const estoques = {};
  let offset = 0;
  const limit = 50;

  while (true) {
    const resp = await axios.get(`https://api.mercadolibre.com/users/${ML_SELLER_ID}/items/search`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { offset, limit, status: 'active' },
    });

    const ids = resp.data.results || [];
    if (ids.length === 0) break;

    // busca detalhes em lote (multiget, máximo 20 por chamada na maioria das contas)
    for (let i = 0; i < ids.length; i += 20) {
      const lote = ids.slice(i, i + 20);
      const detalhes = await axios.get('https://api.mercadolibre.com/items', {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { ids: lote.join(',') },
      });

      for (const entry of detalhes.data) {
        const item = entry.body;
        const sku =
          item.seller_custom_field ||
          item.attributes?.find((a) => a.id === 'SELLER_SKU')?.value_name;
        if (!sku) continue;

        // Um mesmo SKU pode ter mais de um anúncio ativo (ex: clássico + premium,
        // ou republicação sem pausar o anterior). Guarda todos os item_id — a
        // correção automática precisa atualizar TODOS eles, não só um. Pra
        // comparação usa o maior valor entre os anúncios (na prática o Bling
        // sincroniza o mesmo saldo pra cada um; se estiverem dessincronizados
        // entre si, o maior é o mais otimista/atual).
        if (estoques[sku]) {
          estoques[sku].qtd = Math.max(estoques[sku].qtd, item.available_quantity);
          estoques[sku].itens.push({ itemId: item.id, qtd: item.available_quantity });
        } else {
          estoques[sku] = {
            qtd: item.available_quantity,
            nome: item.title,
            itens: [{ itemId: item.id, qtd: item.available_quantity }],
          };
        }
      }
    }

    offset += limit;
  }

  return estoques;
}

// ===== 5. COMPARAÇÃO =====
function compararEstoques(estoqueBling, estoqueML) {
  const divergencias = [];
  const semSkuNoBling = [];

  for (const sku in estoqueML) {
    const bling = estoqueBling[sku];
    const ml = estoqueML[sku];

    if (bling === undefined) {
      semSkuNoBling.push(sku);
      continue;
    }

    // Sinal importa: positivo = Bling tem mais que o ML (só perde exposição
    // de venda); negativo = Bling tem menos que o ML publicado (risco real
    // de vender sem estoque).
    const diferenca = bling.saldo - ml.qtd;
    if (Math.abs(diferenca) > TOLERANCIA) {
      divergencias.push({
        sku,
        nome: bling.nome || ml.nome,
        qtdBling: bling.saldo,
        qtdML: ml.qtd,
        diferenca,
        itens: ml.itens, // uso interno (corrigirEstoqueML) — removido antes de salvar o JSON
      });
    }
  }

  return { divergencias, semSkuNoBling };
}

// ===== 5b. CORREÇÃO AUTOMÁTICA NO ML =====
// Só corrige o sentido de risco (Bling < ML): atualiza o(s) anúncio(s) do ML
// pra baterem com o saldo real do Bling, que é a fonte da verdade. Bling > ML
// não é mexido automaticamente — só sobra estoque não anunciado, sem risco.
async function corrigirEstoqueML(accessToken, divergencias) {
  for (const d of divergencias) {
    if (d.diferenca >= 0) continue; // só corrige quando Bling < ML

    const resultadosPorItem = [];
    for (const item of d.itens) {
      try {
        await axios.put(
          `https://api.mercadolibre.com/items/${item.itemId}`,
          { available_quantity: d.qtdBling },
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        resultadosPorItem.push({ itemId: item.itemId, ok: true });
      } catch (err) {
        resultadosPorItem.push({
          itemId: item.itemId,
          ok: false,
          erro: err.response?.data?.message || err.message,
        });
      }
      await aguardar(250); // folga entre chamadas de escrita no ML
    }

    const falhas = resultadosPorItem.filter((r) => !r.ok);
    d.corrigido = falhas.length === 0;
    d.corrigidoDetalhe = d.corrigido
      ? `${resultadosPorItem.length} anúncio(s) atualizado(s) para ${d.qtdBling}`
      : `Falha em ${falhas.length}/${resultadosPorItem.length} anúncio(s): ${falhas[0].erro}`;

    console.log(
      `SKU ${d.sku}: ${d.corrigido ? 'corrigido' : 'FALHA ao corrigir'} — ${d.corrigidoDetalhe}`
    );
  }
}

// ===== 6. ALERTA DE RISCO (WhatsApp via CallMeBot/Z-API, ou e-mail via Gmail) =====
// Só avisa dos casos que a correção automática NÃO conseguiu resolver sozinha
// (ex: anúncio pausado, erro da API do ML) — o que corrigiu não precisa
// acordar ninguém, já está resolvido.
async function enviarAlertaRisco(divergencias) {
  const risco = divergencias.filter((d) => d.diferenca < 0 && !d.corrigido);
  if (risco.length === 0) return;

  const LIMITE_ITENS = 15;
  const separador = '----------------------------';

  let corpo = `*RISCO DE FURO - CORRECAO AUTOMATICA FALHOU*\n${risco.length} produto(s) precisam de atencao manual\n`;

  for (const d of risco.slice(0, LIMITE_ITENS)) {
    corpo +=
      `\n${separador}\n` +
      `*SKU ${d.sku}*\n` +
      `${d.nome || 'sem nome'}\n` +
      `Bling: ${d.qtdBling}  |  ML: ${d.qtdML}\n` +
      `Faltam *${Math.abs(d.diferenca)}* unidade(s)\n` +
      `Motivo: ${d.corrigidoDetalhe || 'nao corrigido'}\n`;
  }

  if (risco.length > LIMITE_ITENS) {
    corpo += `\n${separador}\n... e mais ${risco.length - LIMITE_ITENS} produto(s) em risco. Veja todos no painel.\n`;
  }

  const enviado = await enviarNotificacao(corpo, `Risco de furo de estoque - ${risco.length} SKU(s)`);
  if (enviado) {
    console.log(`Alerta enviado (${risco.length} SKU(s) em risco).`);
  } else {
    console.log(`${risco.length} SKU(s) em risco de furo, mas nenhum canal de alerta configurado.`);
  }
}

// ===== 7. SALVAR RESULTADO PRO PAINEL (arquivo local, commitado pelo Actions) =====
function salvarResultadoLocal({ totalSkusML, divergencias, semSkuNoBling }) {
  // "sem SKU no Bling" é majoritariamente produto pai (sem estoque próprio,
  // não é um SKU de fato comparável) — não conta como "verificado" no total,
  // senão infla o denominador e derruba o % em dia artificialmente.
  const totalComparavel = totalSkusML - semSkuNoBling.length;
  const corretos = totalComparavel - divergencias.length;

  const resultado = {
    atualizadoEm: new Date().toISOString(),
    totalSkus: totalComparavel,
    corretos,
    totalDivergentes: divergencias.length,
    // [{ sku, qtdBling, qtdML, diferenca, corrigido?, corrigidoDetalhe? }] —
    // "itens" (item_id do ML) é só uso interno, não vai pro painel.
    divergencias: divergencias.map(({ itens, ...resto }) => resto),
    semSkuNoBling, // skus do ML não encontrados no Bling
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(resultado, null, 2));
  console.log(`Resultado salvo em ${OUTPUT_PATH}`);
}

// ===== 7b. HISTÓRICO DE CORREÇÕES (persiste entre execuções) =====
// Depois que um item é corrigido, ele bate com o Bling e some da lista de
// divergências no próximo ciclo — sem isso, não sobraria registro de que a
// correção aconteceu. Guarda um log à parte, mais recente primeiro, e some
// sozinho do histórico depois de alguns dias (não precisa acumular pra
// sempre — o que importa é o que aconteceu recentemente).
const HISTORICO_DIAS = 3;

function registrarHistoricoCorrecoes(divergencias) {
  const corrigidosAgora = divergencias.filter((d) => d.corrigido);

  let historico = [];
  if (fs.existsSync(HISTORICO_PATH)) {
    try {
      historico = JSON.parse(fs.readFileSync(HISTORICO_PATH, 'utf8'));
    } catch {
      historico = [];
    }
  }

  const agora = new Date();
  const limiteData = agora.getTime() - HISTORICO_DIAS * 24 * 60 * 60 * 1000;

  const novasEntradas = corrigidosAgora.map((d) => ({
    sku: d.sku,
    nome: d.nome,
    qtdAnteriorML: d.qtdML,
    qtdNova: d.qtdBling,
    dataHora: agora.toISOString(),
  }));

  historico = [...novasEntradas, ...historico]
    .filter((h) => new Date(h.dataHora).getTime() >= limiteData)
    .slice(0, HISTORICO_MAX);

  fs.writeFileSync(HISTORICO_PATH, JSON.stringify(historico, null, 2));
  if (novasEntradas.length > 0) {
    console.log(`Histórico atualizado: +${novasEntradas.length} correção(ões) registrada(s).`);
  }
}

// ===== 7c. HISTÓRICO MENSAL (furos evitados por mês, sem limite de retenção) =====
// Diferente do histórico de 3 dias acima, aqui guarda só a contagem por mês
// ("2026-08": 12) — cresce muito devagar (1 número a mais por mês), então dá
// pra manter indefinidamente e mostrar tendência ao longo do tempo.
function registrarHistoricoMensal(divergencias) {
  const corrigidosAgora = divergencias.filter((d) => d.corrigido).length;

  let porMes = {};
  if (fs.existsSync(HISTORICO_MENSAL_PATH)) {
    try {
      porMes = JSON.parse(fs.readFileSync(HISTORICO_MENSAL_PATH, 'utf8'));
    } catch {
      porMes = {};
    }
  }

  // Sempre escreve o arquivo, mesmo sem correção nova (corrigidosAgora=0) —
  // senão o "git add historico-mensal.json" do Actions falha com pathspec
  // não encontrado num ciclo sem correção, e derruba o commit inteiro junto.
  const chave = new Date().toISOString().slice(0, 7); // "2026-08"
  porMes[chave] = (porMes[chave] || 0) + corrigidosAgora;

  fs.writeFileSync(HISTORICO_MENSAL_PATH, JSON.stringify(porMes, null, 2));
}

// ===== EXECUÇÃO =====
async function main() {
  const blingToken = await getBlingAccessToken();
  const estoqueBling = await getEstoqueBling(blingToken);

  const mlToken = await getMLAccessToken();
  const estoqueML = await getEstoqueML(mlToken);

  const { divergencias, semSkuNoBling } = compararEstoques(estoqueBling, estoqueML);
  const totalSkusML = Object.keys(estoqueML).length;

  console.log(`Verificação concluída: ${divergencias.length} divergências encontradas.`);
  if (semSkuNoBling.length > 0) {
    console.log(`Aviso: ${semSkuNoBling.length} SKUs do ML não foram encontrados no Bling (verifique cadastro).`);
  }

  await corrigirEstoqueML(mlToken, divergencias);
  registrarHistoricoCorrecoes(divergencias);
  registrarHistoricoMensal(divergencias);
  await enviarAlertaRisco(divergencias);
  salvarResultadoLocal({ totalSkusML, divergencias, semSkuNoBling });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Erro na verificação de estoque:', err.response?.data || err.message);
    process.exit(1);
  });
}
