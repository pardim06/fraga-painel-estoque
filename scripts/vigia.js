// scripts/vigia.js
//
// Vigia do próprio sistema: confere se os arquivos que os outros jobs
// deveriam estar atualizando (estoque, perguntas, reputação, lista de
// compras) realmente estão sendo atualizados na cadência esperada. Se um
// deles parar de atualizar (job quebrado, token expirado, API fora do ar
// etc.) e ninguém perceber, o painel mostra dado velho como se fosse atual —
// esse script existe pra pegar isso antes do dono perceber sozinho.

require('dotenv').config();
const { enviarNotificacao } = require('../lib/notificar');
const { publicarDados, buscarDadosPublicados } = require('../lib/supabase-publicar');

// Limite generoso (6x a cadência real de ~5min / 1x/dia) pra não disparar
// falso alarme por um atraso pontual do GitHub Actions. Cada "arquivo" aqui
// é uma chave publicada no Supabase (lib/supabase-publicar.js), não mais um
// arquivo local — os dados desses módulos não ficam mais no repositório.
const FONTES = [
  { chave: 'estoque', arquivo: 'resultado-verificacao.json', limiteMin: 30, label: 'Estoque Mercado Livre' },
  { chave: 'estoque-bagy', arquivo: 'resultado-bagy.json', limiteMin: 30, label: 'Estoque Bagy' },
  { chave: 'perguntas', arquivo: 'perguntas-ml.json', limiteMin: 30, label: 'Perguntas ML' },
  { chave: 'reputacao', arquivo: 'reputacao-ml.json', limiteMin: 30, label: 'Reputação ML' },
  { chave: 'lista-compras', arquivo: 'lista-compras.json', limiteMin: 60 * 30, label: 'Lista de Compras' },
  // Esses 4 disparam todos no mesmo instante (quando "Gerar lista de compras"
  // termina) e competem pela mesma vaga de fila do grupo de concorrência —
  // é normal e esperado um deles pular um dia de vez em quando (fila só
  // segura 1 pendente, o mais novo derruba o mais antigo). Limite bem mais
  // folgado que o resto (3 dias) pra não alarmar à toa nesse caso comum;
  // só acusa se ficar parado de verdade por vários dias seguidos.
  { chave: 'saude-anuncios', arquivo: 'saude-anuncios.json', limiteMin: 60 * 24 * 3, label: 'Saúde dos Anúncios' },
  { chave: 'medidas', arquivo: 'medidas-ml.json', limiteMin: 60 * 24 * 3, label: 'Medidas ML' },
  { chave: 'buybox', arquivo: 'buybox-ml.json', limiteMin: 60 * 24 * 3, label: 'Buy Box ML' },
  { chave: 'produtos-mes', arquivo: 'produtos-mes.json', limiteMin: 60 * 24 * 3, label: 'Produtos do Mês' },
];

function formatarAtraso(minutos) {
  if (minutos < 60) return `${minutos} min`;
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  return resto === 0 ? `${horas}h` : `${horas}h${resto}min`;
}

async function main() {
  const estadoAnterior = (await buscarDadosPublicados('vigia-estado.json')) || {};
  const estadoNovo = {};
  const ficaramRuins = [];
  const voltaramAoNormal = [];

  for (const fonte of FONTES) {
    let status = 'faltando';
    let atrasoMin = null;

    const dados = await buscarDadosPublicados(fonte.arquivo);
    if (dados) {
      const atualizadoEm = dados.atualizadoEm ? new Date(dados.atualizadoEm) : null;
      if (atualizadoEm && !isNaN(atualizadoEm.getTime())) {
        atrasoMin = Math.round((Date.now() - atualizadoEm.getTime()) / 60000);
        status = atrasoMin > fonte.limiteMin ? 'parado' : 'ok';
      } else {
        status = 'invalido';
      }
    }

    estadoNovo[fonte.chave] = { status, atrasoMin, verificadoEm: new Date().toISOString() };

    const estavaOk = !estadoAnterior[fonte.chave] || estadoAnterior[fonte.chave].status === 'ok';
    const estaRuim = status !== 'ok';

    // Só alerta na transição ok -> ruim, pra não mandar o mesmo aviso de
    // novo a cada 15min enquanto o problema não é resolvido.
    if (estaRuim && estavaOk) {
      ficaramRuins.push({ ...fonte, status, atrasoMin });
    }
    // Avisa também quando volta ao normal, pra confirmar que já resolveu.
    if (!estaRuim && estadoAnterior[fonte.chave] && estadoAnterior[fonte.chave].status !== 'ok') {
      voltaramAoNormal.push(fonte);
    }
  }

  await publicarDados('vigia-estado.json', estadoNovo);

  if (ficaramRuins.length > 0) {
    let corpo = `*ALERTA - MODULO(S) PARADO(S) NO SISTEMA*\n\n`;
    for (const f of ficaramRuins) {
      const detalhe =
        f.status === 'faltando'
          ? 'arquivo nao existe'
          : f.status === 'invalido'
          ? 'arquivo com formato invalido'
          : `sem atualizar ha ${formatarAtraso(f.atrasoMin)} (limite: ${formatarAtraso(f.limiteMin)})`;
      corpo += `*${f.label}*: ${detalhe}\n`;
    }
    corpo += `\nVerifique o GitHub Actions - pode ser token expirado, API fora do ar ou job quebrado.`;

    await enviarNotificacao(corpo, `Alerta - ${ficaramRuins.length} modulo(s) parado(s)`);
    console.log(`Alerta enviado: ${ficaramRuins.map((f) => f.label).join(', ')} parado(s).`);
  }

  if (voltaramAoNormal.length > 0) {
    const corpo = `*Sistema normalizado*\n\n${voltaramAoNormal.map((f) => `${f.label}: voltou a atualizar normalmente.`).join('\n')}`;
    await enviarNotificacao(corpo, 'Sistema normalizado');
    console.log(`Aviso de normalização enviado: ${voltaramAoNormal.map((f) => f.label).join(', ')}.`);
  }

  if (ficaramRuins.length === 0 && voltaramAoNormal.length === 0) {
    // "Nenhuma mudança" não é o mesmo que "tudo ok" — um módulo pode estar
    // parado há dias sem gerar novo alerta (só avisa na transição, pra não
    // repetir o mesmo aviso todo ciclo). Deixa isso explícito no log.
    const aindaParados = Object.entries(estadoNovo)
      .filter(([, v]) => v.status !== 'ok')
      .map(([chave]) => chave);
    if (aindaParados.length > 0) {
      console.log(`Vigia: nenhuma mudança (sem alerta novo), mas ainda parado(s) desde o aviso anterior: ${aindaParados.join(', ')}.`);
    } else {
      console.log('Vigia: tudo em dia, nenhum alerta necessário.');
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Erro no vigia:', err.response?.data || err.message);
    process.exit(1);
  });
}
