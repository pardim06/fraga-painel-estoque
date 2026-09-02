// assets/supabase-auth.js
//
// Login + leitura de dados protegidos no Supabase. A chave publicável
// abaixo é segura de expor (é assim que o Supabase funciona — o RLS na
// tabela dados_painel é quem decide quem lê o quê, não essa chave).
//
// Uso em cada página:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="assets/supabase-auth.js"></script>
//   ... no final da página, troca a chamada direta de carregar() por:
//   verificarAcesso(carregar);
// E troca fetch('arquivo.json') por: await buscarDados('arquivo.json')

const SUPABASE_URL = 'https://oxdfozbomrskufcsokuo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_ntuMHLNMLbvGunWQj_rzRA_bYSA1_Mz';
const EMAIL_PAINEL = 'fraga@gmail.com';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function montarTelaLogin(aoAutenticar) {
  if (document.getElementById('tela-login')) return;

  const div = document.createElement('div');
  div.id = 'tela-login';
  div.innerHTML = `
    <div class="login-card">
      <img src="assets/logo-fraga.png" alt="" class="login-logo">
      <div class="login-titulo">Fraga Bike Shop</div>
      <div class="login-subtitulo">Painel interno — entre com a senha</div>
      <form id="form-login">
        <input type="password" id="senha-login" placeholder="Senha" autocomplete="current-password" required>
        <button type="submit">Entrar</button>
      </form>
      <div id="erro-login" class="erro-login" hidden></div>
    </div>
  `;
  document.body.appendChild(div);

  document.getElementById('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const botao = e.target.querySelector('button');
    const senha = document.getElementById('senha-login').value;
    const erroEl = document.getElementById('erro-login');
    erroEl.hidden = true;
    botao.disabled = true;
    botao.textContent = 'Entrando…';

    const { error } = await supabaseClient.auth.signInWithPassword({ email: EMAIL_PAINEL, password: senha });

    if (error) {
      erroEl.textContent = 'Senha incorreta.';
      erroEl.hidden = false;
      botao.disabled = false;
      botao.textContent = 'Entrar';
      return;
    }

    div.remove();
    document.documentElement.classList.add('autenticado');
    if (aoAutenticar) aoAutenticar();
  });
}

// Chama no final de cada página, no lugar de chamar a função de carregar
// diretamente — só libera o conteúdo depois de confirmar sessão válida.
async function verificarAcesso(aoAutenticar) {
  const { data } = await supabaseClient.auth.getSession();
  if (data.session) {
    document.documentElement.classList.add('autenticado');
    if (aoAutenticar) aoAutenticar();
  } else {
    montarTelaLogin(aoAutenticar);
  }
}

// Busca um registro salvo pelo GitHub Actions (lib/supabase-publicar.js do
// lado do servidor). Retorna null se não achar ou se não estiver logado.
async function buscarDados(chave) {
  const { data, error } = await supabaseClient
    .from('dados_painel')
    .select('conteudo')
    .eq('chave', chave)
    .single();

  if (error || !data) return null;
  return data.conteudo;
}
