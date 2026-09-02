// lib/supabase-publicar.js
//
// Publica um resultado no Supabase (tabela dados_painel) em vez de escrever
// um arquivo e commitar no repositório público. Usa a service_role key —
// só existe como GitHub Secret, nunca no código nem no navegador. É essa
// chave que ignora o RLS e consegue escrever; o navegador só consegue ler,
// e só depois de logado (veja assets/supabase-auth.js).

const axios = require('axios');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Lê o valor atual publicado (pra scripts que fazem histórico incremental,
// tipo "soma no que já tinha" — sem isso não teriam como saber o valor
// anterior, já que o checkout do Actions começa limpo a cada execução e o
// arquivo não é mais commitado no repositório).
async function buscarDadosPublicados(chave) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;

  try {
    const resp = await axios.get(`${SUPABASE_URL}/rest/v1/dados_painel`, {
      params: { chave: `eq.${chave}`, select: 'conteudo' },
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    });
    return resp.data?.[0]?.conteudo ?? null;
  } catch {
    return null;
  }
}

async function publicarDados(chave, dados) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.log(`Aviso: SUPABASE_URL/SUPABASE_SERVICE_KEY não configurados — "${chave}" não foi publicado.`);
    return;
  }

  await axios.post(
    `${SUPABASE_URL}/rest/v1/dados_painel`,
    { chave, conteudo: dados, atualizado_em: new Date().toISOString() },
    {
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
    }
  );
  console.log(`Publicado no Supabase: ${chave}`);
}

// Soma no contador do mês atual — compartilhado entre o verificador do ML e
// o da Bagy, já que "furos evitados por mês" é uma métrica do negócio como
// um todo, não por canal. Lê o valor atual do Supabase antes de somar (não
// dá mais pra confiar em arquivo local — o checkout do Actions começa
// limpo a cada execução).
async function incrementarHistoricoMensal(incremento) {
  const porMes = (await buscarDadosPublicados('historico-mensal.json')) || {};
  const chave = new Date().toISOString().slice(0, 7); // "2026-08"
  porMes[chave] = (porMes[chave] || 0) + incremento;
  await publicarDados('historico-mensal.json', porMes);
  if (incremento > 0) {
    console.log(`Histórico mensal atualizado: +${incremento} furo(s) evitado(s).`);
  }
}

module.exports = { publicarDados, buscarDadosPublicados, incrementarHistoricoMensal };
