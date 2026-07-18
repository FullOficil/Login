"use strict";

const parametrosUrl = new URLSearchParams(window.location.search);
const sessaoEditor = normalizarSessaoEditor(parametrosUrl.get("editorSession"));
const modoUnityEditor = Boolean(sessaoEditor);

const googleLoginButton = document.querySelector("#google-login");
const statusBox = document.querySelector("#status-box");
const statusText = document.querySelector("#status-text");
const connectedAccount = document.querySelector("#connected-account");
const connectedAvatar = document.querySelector("#connected-avatar");
const connectedName = document.querySelector("#connected-name");
const connectedEmail = document.querySelector("#connected-email");
const openAppButton = document.querySelector("#open-app");
const logoutButton = document.querySelector("#logout");

const nicknameModal = document.querySelector("#nickname-modal");
const nicknameInput = document.querySelector("#nickname-input");
const nicknameError = document.querySelector("#nickname-error");
const saveNicknameButton = document.querySelector("#save-nickname");
const cancelNicknameButton = document.querySelector("#cancel-nickname");

let configuracao = null;
let auth = null;
let usuarioAtual = null;
let ultimoLinkApp = null;
let processandoConta = false;
let appJaAbertoNestaSessao = false;

googleLoginButton.addEventListener("click", entrarComGoogle);
openAppButton.addEventListener("click", () => abrirAplicativo(true));
logoutButton.addEventListener("click", sairDaConta);
saveNicknameButton.addEventListener("click", cadastrarNick);
cancelNicknameButton.addEventListener("click", sairDaConta);
nicknameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") cadastrarNick();
});
nicknameInput.addEventListener("input", () => {
  nicknameError.textContent = "";
});

iniciar();

async function iniciar() {
  mostrarStatus("Preparando o login…");

  try {
    configuracao = await buscarJson("/api/configuracao-publica");

    if (!configuracao.autenticacaoDisponivel || !configuracao.firebaseWebConfig) {
      throw new Error("O login Google ainda não está disponível no servidor.");
    }

    if (!firebase.apps.length) {
      firebase.initializeApp(configuracao.firebaseWebConfig);
    }

    auth = firebase.auth();
    await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

    try {
      await auth.getRedirectResult();
    } catch (error) {
      console.error("Falha no retorno do redirecionamento:", error);
    }

    auth.onAuthStateChanged(async (usuario) => {
      usuarioAtual = usuario || null;
      atualizarContaVisual();

      if (!usuarioAtual) {
        googleLoginButton.disabled = false;
        googleLoginButton.hidden = false;
        logoutButton.hidden = true;
        openAppButton.hidden = true;
        ultimoLinkApp = null;
        mostrarStatus("Entre com o Google para continuar.");
        return;
      }

      googleLoginButton.hidden = true;
      logoutButton.hidden = false;
      await verificarContaEContinuar();
    });
  } catch (error) {
    console.error(error);
    googleLoginButton.disabled = true;
    mostrarStatus(error.message || "Não foi possível iniciar o login.", true);
  }
}

async function entrarComGoogle() {
  if (!auth) return;

  googleLoginButton.disabled = true;
  mostrarStatus("Abrindo o login do Google…");

  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  try {
    const resultado = await auth.signInWithPopup(provider);
    usuarioAtual = resultado.user;
  } catch (error) {
    console.error("Falha no login Google:", error);

    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(error.code)) {
      await auth.signInWithRedirect(provider);
      return;
    }

    googleLoginButton.disabled = false;
    const mensagens = {
      "auth/popup-closed-by-user": "O login foi fechado antes de terminar.",
      "auth/cancelled-popup-request": "A tentativa anterior de login foi cancelada.",
      "auth/unauthorized-domain": "Este domínio ainda não foi autorizado no Firebase Authentication."
    };
    mostrarStatus(mensagens[error.code] || "Não foi possível entrar com o Google.", true);
  }
}

async function verificarContaEContinuar() {
  if (!usuarioAtual || processandoConta) return;
  processandoConta = true;
  openAppButton.hidden = true;

  try {
    mostrarStatus("Verificando sua conta do DayZombi…");
    const conta = await buscarJsonAutenticado("/api/minha-conta");

    if (!conta.cadastrado) {
      mostrarStatus("Escolha um Nick para concluir o primeiro acesso.");
      abrirModalNick();
      return;
    }

    fecharModalNick();
    mostrarStatus(`Conta ${conta.conta.nick} reconhecida. Preparando o jogo…`);
    await prepararAberturaDoApp();
  } catch (error) {
    console.error(error);
    mostrarStatus(error.message || "Não foi possível verificar sua conta.", true);
  } finally {
    processandoConta = false;
  }
}

async function cadastrarNick() {
  if (!usuarioAtual) return;

  const nick = normalizarNick(nicknameInput.value);
  if (!nick) {
    nicknameError.textContent = "Digite de 3 a 20 caracteres usando letras, números, _ ou -.";
    return;
  }

  saveNicknameButton.disabled = true;
  cancelNicknameButton.disabled = true;
  nicknameError.textContent = "";

  try {
    const conta = await buscarJsonAutenticado("/api/cadastrar-conta", {
      method: "POST",
      body: JSON.stringify({ nick })
    });

    fecharModalNick();
    mostrarStatus(`Conta ${conta.conta.nick} criada. Preparando o jogo…`);
    await prepararAberturaDoApp();
  } catch (error) {
    console.error(error);
    nicknameError.textContent = error.message || "Não foi possível cadastrar o Nick.";
  } finally {
    saveNicknameButton.disabled = false;
    cancelNicknameButton.disabled = false;
  }
}

async function prepararAberturaDoApp() {
  const resultado = await buscarJsonAutenticado("/api/criar-codigo-login-app", {
    method: "POST",
    body: JSON.stringify({
      sessaoEditor: modoUnityEditor ? sessaoEditor : null
    })
  });

  if (modoUnityEditor) {
    ultimoLinkApp = null;
    openAppButton.hidden = true;
    appJaAbertoNestaSessao = true;
    mostrarStatus("Login concluído. A Unity Editor receberá a conta automaticamente. Volte ao Editor.");
    return;
  }

  ultimoLinkApp = resultado;
  openAppButton.hidden = false;
  mostrarStatus("Login concluído. Abrindo o DayZombi…");

  if (!appJaAbertoNestaSessao) {
    appJaAbertoNestaSessao = true;
    window.setTimeout(() => abrirAplicativo(false), 250);
  }
}

function abrirAplicativo(manual) {
  if (!ultimoLinkApp) {
    if (manual) mostrarStatus("O link do aplicativo ainda não está pronto.", true);
    return;
  }

  mostrarStatus("Tentando abrir o DayZombi…");

  // Usa diretamente o esquema registrado no APK.
  // Não usa intent:// com package= porque, quando o Android não encontra
  // o filtro do aplicativo, o Chrome tenta abrir a Play Store.
  // O DayZombi pode ser instalado por APK e não precisa estar publicado.
  window.location.href = ultimoLinkApp.deepLink;

  window.setTimeout(() => {
    openAppButton.hidden = false;
    mostrarStatus("Caso o jogo não tenha aberto, toque em “Abrir DayZombi”.");
  }, 1800);
}

async function sairDaConta() {
  fecharModalNick();
  appJaAbertoNestaSessao = false;
  ultimoLinkApp = null;
  if (auth) await auth.signOut();
}

function atualizarContaVisual() {
  if (!usuarioAtual) {
    connectedAccount.hidden = true;
    connectedAvatar.removeAttribute("src");
    connectedName.textContent = "";
    connectedEmail.textContent = "";
    return;
  }

  connectedAccount.hidden = false;
  connectedName.textContent = usuarioAtual.displayName || "Jogador DayZombi";
  connectedEmail.textContent = usuarioAtual.email || "";

  if (usuarioAtual.photoURL) {
    connectedAvatar.src = usuarioAtual.photoURL;
    connectedAvatar.hidden = false;
  } else {
    connectedAvatar.hidden = true;
  }
}

function abrirModalNick() {
  nicknameModal.hidden = false;
  nicknameInput.value = "";
  nicknameError.textContent = "";
  window.setTimeout(() => nicknameInput.focus(), 0);
}

function fecharModalNick() {
  nicknameModal.hidden = true;
}

function mostrarStatus(mensagem, erro = false) {
  statusText.textContent = mensagem;
  statusBox.classList.toggle("status-box--error", erro);
}

function normalizarNick(valor) {
  const nick = String(valor || "").normalize("NFKC").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,19}$/.test(nick) ? nick : "";
}

function normalizarSessaoEditor(valor) {
  const sessao = String(valor || "").trim();
  return /^[A-Za-z0-9_-]{32,128}$/.test(sessao) ? sessao : "";
}

async function buscarJson(url, opcoes = {}) {
  // IMPORTANTE: espalhamos as opções antes dos headers.
  // Caso contrário, opcoes.headers substituiria o objeto inteiro e removeria
  // o Content-Type, fazendo o Express ignorar o JSON enviado no body.
  const response = await fetch(url, {
    cache: "no-store",
    ...opcoes,
    headers: {
      "Content-Type": "application/json",
      ...(opcoes.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.erro || "O servidor recusou a solicitação.");
  }

  return data;
}

async function buscarJsonAutenticado(url, opcoes = {}) {
  if (!usuarioAtual) throw new Error("Entre com o Google para continuar.");
  const idToken = await usuarioAtual.getIdToken(true);
  return buscarJson(url, {
    ...opcoes,
    headers: {
      ...(opcoes.headers || {}),
      Authorization: `Bearer ${idToken}`
    }
  });
}
