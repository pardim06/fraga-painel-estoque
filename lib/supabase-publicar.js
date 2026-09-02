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

module.exports = { publicarDados };
