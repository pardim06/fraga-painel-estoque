// scripts/responder-perguntas.js
//
// Pra cada pergunta nova em aberto no Mercado Livre (lida de perguntas-ml.json,
// já gerado pelo verificar-perguntas.js), pede pra Gemini sugerir uma resposta.
//
// Fora do horário comercial (segunda a sexta 18:00-08:10, e sábado/domingo
// o dia todo) a resposta é publicada automaticamente no ML — é quando não
// tem ninguém pra revisar antes. Em horário comercial, só manda o rascunho
// pro dono aprovar via WhatsApp/e-mail e copiar/colar manualmente — mas se
// passar 45 minutos sem aprovação, publica sozinho mesmo assim (pra pergunta
// não ficar sem resposta o dia todo esperando alguém ver o WhatsApp).
//
// Só processa pergunta nova (controlado por respostas-sugeridas.json), pra
// não gastar chamada da API nem repetir notificação a cada ciclo.

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const axios = require('axios');
const { getMLAccessToken } = require('../lib/tokens');
const { gerarRespostaSugerida } = require('../lib/gemini');
const { enviarNotificacao } = require('../lib/notificar');

const PERGUNTAS_PATH = path.join(__dirname, '..', 'perguntas-ml.json');
const ESTADO_PATH = path.join(__dirname, '..', 'respostas-sugeridas.json');
// respostas-sugeridas.json é só controle de dedup (some quando a pergunta
// fecha) — esse aqui é o histórico de verdade, pra acompanhar no painel o
// que a IA já respondeu mesmo depois de fechada.
const HISTORICO_PATH = path.join(__dirname, '..', 'historico-respostas-ia.json');
const HISTORICO_DIAS = 30;
const FUSO = 'America/Sao_Paulo';
// Em horário comercial, se ninguém aprovar em até esse tempo, publica sozinho.
const LIMITE_ESCALONAMENTO_MIN = 45;

function lerJson(caminho) {
  if (!fs.existsSync(caminho)) return null;
  try {
    return JSON.parse(fs.readFileSync(caminho, 'utf8'));
  } catch {
    return null;
  }
}

// Segunda a sexta das 18:00 às 08:10 = fora do horário comercial da loja.
// Sábado e domingo o dia todo também. Nesses períodos não tem ninguém pra
// aprovar manualmente, então a resposta sai automática.
function estaNoHorarioAutomatico(agora = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: FUSO,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const partes = Object.fromEntries(fmt.formatToParts(agora).map((p) => [p.type, p.value]));
  const diaSemana = partes.weekday; // 'Mon'..'Sun'
  const minutosDoDia = parseInt(partes.hour, 10) * 60 + parseInt(partes.minute, 10);

  if (diaSemana === 'Sat' || diaSemana === 'Sun') return true;

  const INICIO_NOITE = 18 * 60; // 18:00
  const FIM_MANHA = 8 * 60 + 10; // 08:10
  return minutosDoDia >= INICIO_NOITE || minutosDoDia < FIM_MANHA;
}

const cacheDescricao = new Map();
async function getDescricaoItem(accessToken, itemId) {
  if (cacheDescricao.has(itemId)) return cacheDescricao.get(itemId);
  let descricao = '';
  try {
    const resp = await axios.get(`https://api.mercadolibre.com/items/${itemId}/description`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    descricao = resp.data?.plain_text || resp.data?.text || '';
  } catch {
    descricao = '';
  }
  cacheDescricao.set(itemId, descricao);
  return descricao;
}

function registrarHistorico(questionId, registro) {
  let historico = {};
  if (fs.existsSync(HISTORICO_PATH)) {
    try {
      historico = JSON.parse(fs.readFileSync(HISTORICO_PATH, 'utf8'));
    } catch {
      historico = {};
    }
  }

  historico[questionId] = registro;

  const limite = Date.now() - HISTORICO_DIAS * 24 * 60 * 60 * 1000;
  for (const id of Object.keys(historico)) {
    if (new Date(historico[id].geradoEm).getTime() < limite) delete historico[id];
  }

  fs.writeFileSync(HISTORICO_PATH, JSON.stringify(historico, null, 2));
}

async function postarRespostaML(accessToken, questionId, texto) {
  await axios.post(
    'https://api.mercadolibre.com/answers',
    { question_id: questionId, text: texto },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
}

function formatarNotificacao({ autoRespondidas, escalonadas, aguardandoAprovacao }) {
  const separador = '----------------------------';
  let corpo = '';

  if (autoRespondidas.length > 0) {
    corpo += `*RESPONDIDO AUTOMATICAMENTE - FORA DO HORARIO COMERCIAL*\n${autoRespondidas.length} pergunta(s) ja respondida(s) no ML\n`;
    for (const r of autoRespondidas) {
      corpo += `\n${separador}\n*${r.produto}*\nPergunta: ${r.pergunta}\n\nResposta publicada:\n${r.resposta}\n`;
    }
  }

  if (escalonadas.length > 0) {
    corpo += `\n${separador}\n*RESPONDIDO AUTOMATICAMENTE - SEM APROVACAO EM ${LIMITE_ESCALONAMENTO_MIN}MIN*\n${escalonadas.length} pergunta(s) publicada(s) sozinha(s) por falta de resposta\n`;
    for (const r of escalonadas) {
      corpo += `\n${separador}\n*${r.produto}*\nPergunta: ${r.pergunta}\n\nResposta publicada:\n${r.resposta}\n`;
    }
  }

  if (aguardandoAprovacao.length > 0) {
    corpo += `\n${separador}\n*SUGESTAO DE RESPOSTA - AGUARDANDO APROVACAO*\n${aguardandoAprovacao.length} pergunta(s) nova(s) com rascunho pronto\n`;
    for (const r of aguardandoAprovacao) {
      corpo += `\n${separador}\n*${r.produto}*\nPergunta: ${r.pergunta}\n\nSugestao de resposta:\n${r.resposta}\n`;
    }
    corpo += `\n${separador}\nRevise antes de enviar - copie e cole no app do Mercado Livre se estiver de acordo.`;
  }

  return corpo.trim();
}

async function main() {
  // Garante que o arquivo existe mesmo sem pergunta nova nesse ciclo — senão
  // o "git add" do Actions falha com pathspec não encontrado na primeira
  // execução (mesmo bug que já pegou o historico-mensal.json antes).
  if (!fs.existsSync(HISTORICO_PATH)) {
    fs.writeFileSync(HISTORICO_PATH, JSON.stringify({}, null, 2));
  }

  const perguntasData = lerJson(PERGUNTAS_PATH);
  if (!perguntasData || !Array.isArray(perguntasData.perguntas)) {
    console.log('perguntas-ml.json ainda não existe ou está vazio — nada a fazer.');
    return;
  }

  const abertasIds = new Set(perguntasData.perguntas.map((p) => String(p.id)));
  let estado = lerJson(ESTADO_PATH) || {};

  // Limpa do estado quem não está mais em aberto (foi respondida ou expirou) —
  // assim, se a MESMA pergunta reaparecer um dia (não deveria, mas por
  // segurança), ganha um rascunho novo em vez de ficar presa num estado velho.
  for (const id of Object.keys(estado)) {
    if (!abertasIds.has(id)) delete estado[id];
  }

  const novas = perguntasData.perguntas.filter((p) => !estado[String(p.id)]);

  const limiteEscalonamento = Date.now() - LIMITE_ESCALONAMENTO_MIN * 60 * 1000;
  const paraEscalar = Object.entries(estado).filter(
    ([, r]) => r.status === 'aguardando_aprovacao' && new Date(r.geradoEm).getTime() <= limiteEscalonamento
  );

  if (novas.length === 0 && paraEscalar.length === 0) {
    fs.writeFileSync(ESTADO_PATH, JSON.stringify(estado, null, 2));
    console.log('Nenhuma pergunta nova e nada pra escalar. Nada a notificar.');
    return;
  }

  const automatico = estaNoHorarioAutomatico();
  console.log(automatico ? 'Fora do horário comercial: respostas serão publicadas automaticamente.' : 'Horário comercial: respostas ficam pendentes de aprovação.');

  const token = await getMLAccessToken();
  const autoRespondidas = [];
  const escalonadas = [];
  const aguardandoAprovacao = [];

  // Pendente há mais de 45min sem aprovação humana — publica sozinho mesmo
  // sendo horário comercial, usando o texto que já foi gerado (não gasta
  // chamada nova da IA).
  for (const [id, registro] of paraEscalar) {
    try {
      await postarRespostaML(token, Number(id), registro.resposta);
      registro.status = 'auto_respondida';
      registro.respondidoEm = new Date().toISOString();
      estado[id] = registro;
      registrarHistorico(id, registro);
      escalonadas.push(registro);
    } catch (err) {
      console.error(`Falha ao escalar pergunta ${id} após ${LIMITE_ESCALONAMENTO_MIN}min sem aprovação:`, err.response?.data || err.message);
    }
  }

  for (const p of novas) {
    try {
      const descricao = await getDescricaoItem(token, p.itemId);
      const resposta = await gerarRespostaSugerida({
        produto: p.produto,
        descricao,
        pergunta: p.texto,
      });

      const registro = {
        pergunta: p.texto,
        resposta,
        produto: p.produto,
        link: p.link,
        geradoEm: new Date().toISOString(),
        status: 'aguardando_aprovacao',
      };

      if (automatico) {
        try {
          await postarRespostaML(token, p.id, resposta);
          registro.status = 'auto_respondida';
          registro.respondidoEm = new Date().toISOString();
          autoRespondidas.push(registro);
        } catch (err) {
          console.error(`Falha ao publicar resposta automática da pergunta ${p.id}, caiu pra aprovação manual:`, err.response?.data || err.message);
          aguardandoAprovacao.push(registro);
        }
      } else {
        aguardandoAprovacao.push(registro);
      }

      estado[String(p.id)] = registro;
      registrarHistorico(String(p.id), registro);
    } catch (err) {
      console.error(`Erro ao gerar resposta pra pergunta ${p.id}:`, err.response?.data || err.message);
    }
  }

  fs.writeFileSync(ESTADO_PATH, JSON.stringify(estado, null, 2));

  const total = autoRespondidas.length + escalonadas.length + aguardandoAprovacao.length;
  if (total > 0) {
    await enviarNotificacao(
      formatarNotificacao({ autoRespondidas, escalonadas, aguardandoAprovacao }),
      `${total} pergunta(s) do ML processada(s)`
    );
    console.log(
      `${autoRespondidas.length} respondida(s) automaticamente, ${escalonadas.length} escalonada(s) após ${LIMITE_ESCALONAMENTO_MIN}min, ${aguardandoAprovacao.length} aguardando aprovação.`
    );
  } else {
    console.log('Nenhum rascunho gerado com sucesso.');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Erro ao gerar respostas sugeridas:', err.response?.data || err.message);
    process.exit(1);
  });
}
