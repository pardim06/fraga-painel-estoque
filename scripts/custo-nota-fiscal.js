// scripts/custo-nota-fiscal.js
//
// Propõe (NÃO aplica) atualização de custo dos produtos no Bling com base no
// valor unitário da ÚLTIMA nota fiscal de ENTRADA (compra de fornecedor) de
// cada um, num período escolhido. Baseado num script do Moisés que já roda
// fora desse repo — portado aqui reaproveitando o token/rate-limit do Bling
// que o resto do painel já usa.
//
// Uso manual (teste local):
//   node scripts/custo-nota-fiscal.js --dias=90
//   node scripts/custo-nota-fiscal.js --dataInicial=2026-01-01 --dataFinal=2026-11-01
// Em produção roda via workflow_dispatch (.github/workflows/custo-nota-fiscal.yml),
// com os mesmos parâmetros como input do workflow.
//
// NÃO escreve nada no Bling. Só publica a proposta no Supabase
// (chave "custo-nota-proposta.json") pro painel mostrar. Aplicar de verdade
// é uma etapa separada, ainda não construída — de propósito, igual o script
// original: custo errado em massa é caro demais pra arriscar sem revisão.

require('dotenv').config();
const axios = require('axios');
const { getBlingAccessToken } = require('../lib/tokens');
const { blingGet } = require('../lib/bling-http');
const { publicarDados } = require('../lib/supabase-publicar');

const LIMITE_VARIACAO_PCT = Number(process.env.LIMITE_VARIACAO_PCT || 30);
const QTD_MINIMA = Number(process.env.QTD_MINIMA || 1);

function lerArgs() {
  const args = {};
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

function resolverPeriodo() {
  const args = lerArgs();
  const dataFinal = args.dataFinal || process.env.DATA_FINAL || new Date().toISOString().slice(0, 10);
  let dataInicial = args.dataInicial || process.env.DATA_INICIAL;
  if (!dataInicial) {
    const dias = Number(args.dias || process.env.DIAS || 90);
    const d = new Date(dataFinal + 'T00:00:00');
    d.setDate(d.getDate() - dias);
    dataInicial = d.toISOString().slice(0, 10);
  }
  return { dataInicial, dataFinal };
}

const so = (s) => String(s || '').replace(/\D/g, '');
const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));

async function buscarCnpjEmpresa(token) {
  const resp = await blingGet('https://api.bling.com.br/Api/v3/empresas/me/dados-basicos', {
    headers: { Authorization: `Bearer ${token}` },
  });
  return so(resp.data.data?.cnpj);
}

async function listarNotasEntrada(token, dataInicial, dataFinal) {
  const notas = [];
  for (let pagina = 1; ; pagina++) {
    const resp = await blingGet('https://api.bling.com.br/Api/v3/nfe', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        tipo: 0,
        pagina,
        limite: 100,
        dataEmissaoInicial: `${dataInicial} 00:00:00`,
        dataEmissaoFinal: `${dataFinal} 23:59:59`,
      },
    });
    const dados = resp.data.data || [];
    notas.push(...dados.map((n) => ({ id: n.id, numero: n.numero, data: n.dataEmissao })));
    if (dados.length < 100) break;
  }
  // mais nova primeiro — importante pra "última nota por produto" pegar certo
  return notas.sort((a, b) => String(b.data).localeCompare(String(a.data)));
}

async function lerDetalheNotas(token, notas, meuCnpj) {
  const compras = [];
  const ignoradas = { propria: 0, cancelada: 0, semChave: 0 };

  for (const n of notas) {
    const resp = await blingGet(`https://api.bling.com.br/Api/v3/nfe/${n.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const d = resp.data.data;
    const emitente = so(d.chaveAcesso).slice(6, 20); // CNPJ do emitente dentro da chave de acesso

    if (!emitente) { ignoradas.semChave++; continue; }
    if (emitente === meuCnpj) { ignoradas.propria++; continue; } // emitida por nós = venda/devolução, não compra
    if ([2, 4, 9].includes(d.situacao)) { ignoradas.cancelada++; continue; }

    compras.push({
      id: n.id,
      numero: d.numero,
      data: d.dataEmissao,
      fornecedor: d.contato?.nome,
      fornecedorId: d.contato?.id,
      itens: (d.itens || []).map((it) => ({
        codigo: it.codigo || '',
        gtin: so(it.gtin),
        descricao: it.descricao,
        qtd: num(it.quantidade),
        valor: num(it.valor),
      })),
    });
  }

  return { compras, ignoradas };
}

function chaveItem(it) {
  if (it.gtin.length >= 8 && !/^0+$/.test(it.gtin)) return `G:${it.gtin}`;
  if (it.codigo) return `C:${it.codigo}`;
  return null;
}

async function acharProduto(token, chave) {
  const [tipo, valor] = [chave[0], chave.slice(2)];
  const query = tipo === 'G' ? { gtins: [valor] } : { codigos: [valor] };
  const resp = await blingGet('https://api.bling.com.br/Api/v3/produtos', {
    headers: { Authorization: `Bearer ${token}` },
    params: { ...query, criterio: 5, limite: 100 },
  });
  return resp.data.data || [];
}

async function gerarProposta(token, dataInicial, dataFinal) {
  const meuCnpj = await buscarCnpjEmpresa(token);
  const notas = await listarNotasEntrada(token, dataInicial, dataFinal);
  const { compras, ignoradas } = await lerDetalheNotas(token, notas, meuCnpj);

  const ultima = new Map(); // chave -> item mais recente (compras já ordenadas da mais nova pra mais antiga)
  for (const n of compras) {
    for (const it of n.itens) {
      const k = chaveItem(it);
      if (k && !ultima.has(k) && it.valor > 0) ultima.set(k, { ...it, nota: n });
    }
  }

  const linhas = [];
  let iguais = 0;

  for (const [chave, it] of ultima) {
    const achados = await acharProduto(token, chave);
    const base = {
      fornecedor: it.nota.fornecedor,
      fornecedorId: it.nota.fornecedorId,
      nota: it.nota.numero,
      data: String(it.nota.data).slice(0, 10),
      qtd: it.qtd,
      custoNota: it.valor,
      metodo: chave[0] === 'G' ? 'GTIN' : 'CODIGO',
      descricaoNota: it.descricao,
    };

    if (achados.length === 0) {
      linhas.push({ ...base, status: 'SEM_PRODUTO', sugeridoAplicar: false, motivo: 'nenhum produto encontrado' });
      continue;
    }
    if (achados.length > 1) {
      linhas.push({ ...base, status: 'AMBIGUO', sugeridoAplicar: false, motivo: `${achados.length} produtos batem com essa chave`, skusAmbiguos: achados.map((p) => p.codigo) });
      continue;
    }

    const p = achados[0];
    const custoAtual = num(p.precoCusto) || 0;
    if (Math.abs(custoAtual - it.valor) < 0.005) { iguais++; continue; }

    const pct = custoAtual > 0 ? ((it.valor - custoAtual) / custoAtual) * 100 : null;
    const motivos = [];
    if (p.situacao === 'E') motivos.push('produto excluído');
    if (pct === null) motivos.push('custo atual zerado');
    else if (Math.abs(pct) > LIMITE_VARIACAO_PCT) motivos.push(`variação acima de ${LIMITE_VARIACAO_PCT}%`);
    if (it.qtd < QTD_MINIMA) motivos.push(`quantidade na nota menor que ${QTD_MINIMA}`);
    if (p.formato && p.formato !== 'S') motivos.push(`formato ${p.formato} (não é produto simples)`);

    linhas.push({
      ...base,
      status: 'OK',
      sku: p.codigo,
      produtoId: p.id,
      produto: p.nome,
      custoAtual,
      custoNota: it.valor,
      variacaoPct: pct === null ? null : Math.round(pct * 10) / 10,
      motivo: motivos.join('; ') || null,
      sugeridoAplicar: motivos.length === 0,
    });
  }

  linhas.sort((a, b) => (a.status === b.status ? 0 : a.status === 'OK' ? -1 : 1));

  return {
    periodo: { dataInicial, dataFinal },
    atualizadoEm: new Date().toISOString(),
    totalNotasAnalisadas: compras.length,
    notasIgnoradas: ignoradas,
    totalItensDistintos: ultima.size,
    totalJaIguais: iguais,
    totalMudariam: linhas.length,
    totalSugeridoAplicar: linhas.filter((l) => l.sugeridoAplicar).length,
    linhas,
  };
}

async function main() {
  const { dataInicial, dataFinal } = resolverPeriodo();
  console.log(`Gerando proposta de custo a partir de notas fiscais de ${dataInicial} até ${dataFinal}...`);

  const token = await getBlingAccessToken();
  const proposta = await gerarProposta(token, dataInicial, dataFinal);

  await publicarDados('custo-nota-proposta.json', proposta);
  console.log(
    `Proposta publicada: ${proposta.totalNotasAnalisadas} nota(s) de compra analisada(s), ` +
    `${proposta.totalMudariam} produto(s) com custo diferente (${proposta.totalSugeridoAplicar} sugerido(s) aplicar), ` +
    `${proposta.totalJaIguais} já em dia. Nada foi alterado no Bling.`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Erro ao gerar proposta de custo:', err.response?.data || err.message);
    process.exit(1);
  });
}
