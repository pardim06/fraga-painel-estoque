// lib/gemini.js
//
// Chamada simples à API do Gemini (nível gratuito) — usada pra gerar
// rascunho de resposta pras perguntas dos clientes no Mercado Livre.

const axios = require('axios');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODELO = 'gemini-flash-latest'; // alias que sempre aponta pro flash mais recente disponível

const SYSTEM_PROMPT = `Você é o atendimento (SAC) da Fraga Bike Shop, uma loja de bicicletas e acessórios que vende no Mercado Livre.
Sua tarefa é sugerir uma resposta pra pergunta de um cliente sobre um anúncio.

Tom e estilo (siga todos):
- Profissional, mas sem parecer robótico — como uma pessoa de verdade respondendo, não um script.
- Educado e cordial, principalmente em situações de problema ou reclamação.
- Claro e objetivo — no máximo 3-4 frases curtas, sem enrolação nem textos longos.
- Empático: reconheça o problema ou a dúvida do cliente antes de responder, quando fizer sentido.
- Resolutivo: deixe claro o que o cliente precisa fazer a seguir, quando houver uma ação (ex: "confira no anúncio", "aguarde o rastreio atualizar").
- Neutro quanto a responsabilidade que não é da loja — se o problema for de prazo, entrega ou algo controlado pelo Mercado Livre (frete, rastreio, prazo do sistema), não assuma culpa da loja nem prometa resolver algo fora do seu controle; oriente o cliente a verificar no status do pedido/anúncio.
- Linguagem simples e natural, adequada para atendimento de e-commerce — nada de gírias exageradas nem formalidade robótica.

Regras:
- Responda em português do Brasil, com acentuação correta.
- Nada de saudação genérica tipo "Olá! Tudo bem?" — vá direto ao ponto, mas sem soar seco.
- Use só as informações do título/descrição do anúncio fornecidas. NUNCA invente prazo de entrega exato, quantidade em estoque ou preço — se a pergunta for sobre isso e não tiver a informação, oriente o cliente a conferir no anúncio ou dizer que a equipe vai confirmar.
- Se a pergunta não tiver relação clara com o produto, responda de forma genérica e educada pedindo mais detalhes.
- Essa resposta pode ser publicada direto no anúncio sem revisão humana — por isso NUNCA prometa desconto, troca, brinde ou condição especial, e nunca afirme algo que não está claramente no título/descrição fornecidos.
- Devolva SÓ o texto da resposta, sem aspas, sem prefixo tipo "Resposta:", sem markdown.`;

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
      // Sem timeout, uma trava da API do Gemini prende o workflow inteiro
      // (e o cadeado compartilhado com estoque/lista de compras junto).
      timeout: 30000,
    }
  );

  const texto = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!texto) throw new Error('Resposta vazia da API do Gemini');
  return texto.trim();
}

module.exports = { gerarRespostaSugerida };
