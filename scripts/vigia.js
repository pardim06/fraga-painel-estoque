// scripts/vigia.js
//
// Vigia do próprio sistema: confere se os arquivos que os outros jobs
// deveriam estar atualizando (estoque, perguntas, reputação, lista de
// compras) realmente estão sendo atualizados na cadência esperada. Se um
// deles parar de atualizar (job quebrado, token expirado, API fora do ar
// etc.) e ninguém perceber, o painel mostra dado velho como se fosse atual —
// esse script existe pra pegar isso antes do dono perceber sozinho.

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { enviarNotificacao } = require('../lib/notificar');

const ESTADO_PATH = path.join(__dirname, '..', 'vigia-estado.json');

// Limite generoso (6x a cadência real de ~5min / 1x/dia) pra não disparar
// falso alarme por um atraso pontual do GitHub Actions.
const FONTES = [
  { chave: 'estoque', arquivo: 'resultado-verificacao.json', limiteMin: 30, label: 'Estoque Mercado Livre' },
  { chave: 'estoque-bagy', arquivo: 'resultado-bagy.json', limiteMin: 30, label: 'Estoque Bagy' },
  { chave: 'perguntas', arquivo: 'perguntas-ml.json', limiteMin: 30, label: 'Perguntas ML' },
  { chave: 'reputacao', arquivo: 'reputacao-ml.json', limiteMin: 30, label: 'Reputação ML' },
  { chave: 'lista-compras', arquivo: 'lista-compras.json', limiteMin: 60 * 30, label: 'Lista de Compras' },
];

function lerEstado() {
  if (!fs.existsSync(ESTADO_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(ESTADO_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function salvarEstado(estado) {
  fs.writeFileSync(ESTADO_PATH, JSON.stringify(estado, null, 2));
}

function formatarAtraso(minutos) {
  if (minutos < 60) return `${minutos} min`;
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  return resto === 0 ? `${horas}h` : `${horas}h${resto}min`;
}

async function main() {
  const estadoAnterior = lerEstado();
  const estadoNovo = {};
  const ficaramRuins = [];
  const voltaramAoNormal = [];

  for (const fonte of FONTES) {
    const caminho = path.join(__dirname, '..', fonte.arquivo);
    let status = 'faltando';
    let atrasoMin = null;

    if (fs.existsSync(caminho)) {
      try {
        const dados = JSON.parse(fs.readFileSync(caminho, 'utf8'));
        const atualizadoEm = dados.atualizadoEm ? new Date(dados.atualizadoEm) : null;
        if (atualizadoEm && !isNaN(atualizadoEm.getTime())) {
          atrasoMin = Math.round((Date.now() - atualizadoEm.getTime()) / 60000);
          status = atrasoMin > fonte.limiteMin ? 'parado' : 'ok';
        }
      } catch {
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

  salvarEstado(estadoNovo);

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
    console.log('Vigia: tudo em dia, nenhum alerta necessário.');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Erro no vigia:', err.response?.data || err.message);
    process.exit(1);
  });
}
