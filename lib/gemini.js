// lib/gemini.js
//
// Chamada simples à API do Gemini (nível gratuito) — usada pra gerar
// rascunho de resposta pras perguntas dos clientes no Mercado Livre.

const axios = require('axios');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODELO = 'gemini-flash-latest'; // alias que sempre aponta pro flash mais recente disponível

const SYSTEM_PROMPT = `Você é o atendimento (SAC) da Fraga Bike Shop, uma loja de bicicletas e acessórios que vende no Mercado Livre.
Sua tarefa é sugerir uma resposta pra pergunta de um cliente sobre um anúncio.

Regras:
- Responda em português do Brasil, com um tom caloroso, gentil e simpático — como um vendedor de loja de bike que gosta de ajudar o cliente, não um script seco. Pode soar humano e receptivo, sem ficar formal ou robótico.
- No máximo 3-4 frases curtas. Evite saudação genérica tipo "Olá! Tudo bem?", mas pode abrir a resposta com uma palavra acolhedora antes de ir ao ponto.
- Use só as informações do título/descrição do anúncio fornecidas. NUNCA invente prazo de entrega exato, quantidade em estoque ou preço — se a pergunta for sobre isso e não tiver a informação, oriente o cliente a conferir no anúncio ou dizer que a equipe vai confirmar.
- Se a pergunta não tiver relação clara com o produto, responda de forma genérica e educada pedindo mais detalhes.
- Essa resposta pode ser publicada direto no anúncio sem revisão humana (fora do horário comercial) — por isso NUNCA prometa desconto, troca, brinde ou condição especial, e nunca afirme algo que não está claramente no título/descrição fornecidos.
- Devolva SÓ o texto da resposta, sem aspas, sem prefixo tipo "Resposta:".`;

async function gerarRespostaSugerida({ produto, descricao, pergunta }) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY não configurada');
  }

  const contexto =
    `Produto: ${produto}\n` +
    `Descrição do anúncio: ${(descricao || 'sem descrição cadastrada').slice(0, 1500)}\n\n` +
    `Pergunta do cliente: ${pergunta}`;

  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`,
    {
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: contexto }] }],
      // Esse modelo gasta uma parte do limite "pensando" antes de responder
      // (varia bastante, já vi 400+ tokens só de raciocínio) — um limite
      // baixo cortava a resposta no meio da frase.
      generationConfig: { maxOutputTokens: 2048 },
    },
    {
      params: { key: GEMINI_API_KEY },
      headers: { 'content-type': 'application/json' },
    }
  );

  const texto = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!texto) throw new Error('Resposta vazia da API do Gemini');
  return texto.trim();
}

module.exports = { gerarRespostaSugerida };
