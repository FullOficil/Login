"use strict";

require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const path = require("path");
const {
  initializeApp,
  applicationDefault,
  cert
} = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getDatabase } = require("firebase-admin/database");

const app = express();
app.disable("x-powered-by");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = normalizarUrlPublica(process.env.PUBLIC_URL || "");
const FIREBASE_DATABASE_URL = String(
  process.env.FIREBASE_DATABASE_URL ||
  "https://dayzozmbi-server-default-rtdb.firebaseio.com"
).trim();

const FIREBASE_WEB_CONFIG = Object.freeze({
  apiKey: String(process.env.FIREBASE_WEB_API_KEY || "").trim(),
  authDomain: String(
    process.env.FIREBASE_AUTH_DOMAIN || "dayzozmbi-server.firebaseapp.com"
  ).trim(),
  projectId: String(
    process.env.FIREBASE_WEB_PROJECT_ID || "dayzozmbi-server"
  ).trim(),
  databaseURL: FIREBASE_DATABASE_URL,
  storageBucket: String(
    process.env.FIREBASE_STORAGE_BUCKET ||
    "dayzozmbi-server.firebasestorage.app"
  ).trim(),
  messagingSenderId: String(
    process.env.FIREBASE_MESSAGING_SENDER_ID || "221905253103"
  ).trim()
});

const FIREBASE_LOGINS_PATH = "LOGINS_REGISTRADOS";
const FIREBASE_LOGIN_APP_PATH = "LOGIN_APP";
const APP_PACKAGE = String(
  process.env.APP_PACKAGE || "com.VerteSZ.DayZombi"
).trim();
const APP_SCHEME = normalizarScheme(process.env.APP_SCHEME || "dayzombi");
const CODIGO_LOGIN_TTL_MS = 5 * 60 * 1000;

const firebaseWebConfigurado =
  FIREBASE_WEB_CONFIG.apiKey.length > 20 &&
  FIREBASE_WEB_CONFIG.authDomain.length > 5 &&
  FIREBASE_WEB_CONFIG.projectId.length > 2;

let firebaseDb = null;
let firebaseAuth = null;
let firebaseErroInicializacao = null;

try {
  const credential = carregarCredencialFirebase();
  if (credential) {
    const firebaseApp = initializeApp({
      credential,
      databaseURL: FIREBASE_DATABASE_URL
    });
    firebaseDb = getDatabase(firebaseApp);
    firebaseAuth = getAuth(firebaseApp);
  }
} catch (error) {
  firebaseErroInicializacao = error;
  console.error("Firebase não foi inicializado:", error.message);
}

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: "5m"
}));

app.get("/api/saude", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    online: true,
    firebaseAdminConfigurado: Boolean(firebaseDb && firebaseAuth),
    firebaseWebConfigurado,
    firebaseErro: firebaseErroInicializacao?.message || null,
    publicUrlConfigurada: Boolean(PUBLIC_URL),
    appPackage: APP_PACKAGE,
    appScheme: APP_SCHEME
  });
});

app.get("/api/configuracao-publica", (_req, res) => {
  res.set("Cache-Control", "no-store");

  if (!firebaseWebConfigurado) {
    return res.status(500).json({
      erro: "Configure FIREBASE_WEB_API_KEY no Render."
    });
  }

  return res.json({
    firebaseWebConfig: FIREBASE_WEB_CONFIG,
    autenticacaoDisponivel: Boolean(firebaseAuth && firebaseWebConfigurado),
    appPackage: APP_PACKAGE,
    appScheme: APP_SCHEME
  });
});

app.get("/api/minha-conta", async (req, res) => {
  res.set("Cache-Control", "no-store");

  if (!firebaseDb) {
    return res.status(503).json({
      cadastrado: false,
      erro: "Firebase Admin ainda não foi configurado no servidor."
    });
  }

  try {
    const usuario = await obterUsuarioAutenticado(req);
    const contaRef = firebaseDb.ref(
      `${FIREBASE_LOGINS_PATH}/USUARIOS/${usuario.uid}`
    );
    const snapshot = await contaRef.once("value");
    const conta = snapshot.val();

    if (!conta?.Dados?.nick) {
      return res.json({
        autenticado: true,
        cadastrado: false,
        usuario: usuarioPublico(usuario)
      });
    }

    const agora = Date.now();
    await contaRef.child("Dados").update({
      googleEmail: usuario.email || conta.Dados.googleEmail || "",
      googleNome: usuario.nome || conta.Dados.googleNome || "",
      googleFoto: usuario.foto || conta.Dados.googleFoto || "",
      provedor: usuario.provedor || conta.Dados.provedor || "google.com",
      emailVerificado: Boolean(usuario.emailVerificado),
      ultimoLoginEm: agora,
      atualizadoEm: agora
    });

    return res.json({
      autenticado: true,
      cadastrado: true,
      usuario: usuarioPublico(usuario),
      conta: contaPublica({
        ...conta,
        Dados: {
          ...conta.Dados,
          ultimoLoginEm: agora,
          atualizadoEm: agora
        }
      })
    });
  } catch (error) {
    return responderErro(res, error);
  }
});

app.post("/api/cadastrar-conta", async (req, res) => {
  res.set("Cache-Control", "no-store");

  if (!firebaseDb) {
    return res.status(503).json({
      cadastrado: false,
      erro: "Firebase Admin ainda não foi configurado no servidor."
    });
  }

  try {
    const usuario = await obterUsuarioAutenticado(req);
    const nickInfo = normalizarNickConta(req.body?.nick);

    if (!nickInfo) {
      return res.status(400).json({
        cadastrado: false,
        erro: "Use de 3 a 20 caracteres: letras, números, _ ou -. O Nick deve começar com letra ou número."
      });
    }

    const loginsRef = firebaseDb.ref(FIREBASE_LOGINS_PATH);
    let nickEmUso = false;

    const transacao = await loginsRef.transaction((estadoAtual) => {
      const logins = clonarObjeto(estadoAtual);
      const usuarios = clonarObjeto(logins.USUARIOS);
      const nicks = clonarObjeto(logins.NICKS);
      const uidParaNick = clonarObjeto(logins.UID_PARA_NICK);
      const contaExistente = clonarObjeto(usuarios[usuario.uid]);

      if (contaExistente?.Dados?.nick) {
        return logins;
      }

      const donoNick = nicks[nickInfo.nickKey]?.uid;
      if (donoNick && donoNick !== usuario.uid) {
        nickEmUso = true;
        return;
      }

      const agora = Date.now();
      usuarios[usuario.uid] = {
        Dados: {
          firebaseUid: usuario.uid,
          googleEmail: usuario.email || "",
          googleNome: usuario.nome || "",
          googleFoto: usuario.foto || "",
          provedor: usuario.provedor || "google.com",
          emailVerificado: Boolean(usuario.emailVerificado),
          nick: nickInfo.nick,
          nickChave: nickInfo.nickKey,
          criadoEm: agora,
          ultimoLoginEm: agora,
          atualizadoEm: agora
        },
        Eventos: {
          Resumo: {
            valorDoado: 0,
            totalContribuido: 0,
            comprouAcessoTeste: false,
            dataCompraAcessoTeste: null,
            quantidadeDoacoes: 0,
            atualizadoEm: agora
          },
          Pagamentos: {}
        }
      };

      nicks[nickInfo.nickKey] = {
        uid: usuario.uid,
        nick: nickInfo.nick,
        criadoEm: agora
      };

      uidParaNick[usuario.uid] = {
        nickChave: nickInfo.nickKey,
        nick: nickInfo.nick
      };

      logins.USUARIOS = usuarios;
      logins.NICKS = nicks;
      logins.UID_PARA_NICK = uidParaNick;
      return logins;
    }, undefined, false);

    if (!transacao.committed) {
      if (nickEmUso) {
        return res.status(409).json({
          cadastrado: false,
          erro: "Esse Nick já está sendo usado. Escolha outro."
        });
      }

      return res.status(500).json({
        cadastrado: false,
        erro: "Não foi possível registrar a conta agora."
      });
    }

    const conta = transacao.snapshot
      .child(`USUARIOS/${usuario.uid}`)
      .val();

    return res.status(201).json({
      autenticado: true,
      cadastrado: true,
      usuario: usuarioPublico(usuario),
      conta: contaPublica(conta)
    });
  } catch (error) {
    return responderErro(res, error);
  }
});

// Cria um código curto, temporário e de uso único para entregar o login ao jogo.
// O token real do Firebase nunca é colocado no link que abre o aplicativo.
app.post("/api/criar-codigo-login-app", async (req, res) => {
  res.set("Cache-Control", "no-store");

  if (!firebaseDb) {
    return res.status(503).json({
      criado: false,
      erro: "Servidor de login do aplicativo indisponível."
    });
  }

  try {
    const usuario = await obterUsuarioAutenticado(req);
    const contaSnapshot = await firebaseDb
      .ref(`${FIREBASE_LOGINS_PATH}/USUARIOS/${usuario.uid}`)
      .once("value");
    const conta = contaSnapshot.val();

    if (!conta?.Dados?.nick) {
      return res.status(409).json({
        criado: false,
        precisaCadastrarNick: true,
        erro: "Cadastre o Nick antes de entrar no jogo."
      });
    }

    const codigo = crypto.randomBytes(32).toString("base64url");
    const codigoHash = criarHash(codigo);
    const agora = Date.now();
    const expiraEm = agora + CODIGO_LOGIN_TTL_MS;

    await firebaseDb
      .ref(`${FIREBASE_LOGIN_APP_PATH}/CODIGOS/${codigoHash}`)
      .set({
        uid: usuario.uid,
        nick: conta.Dados.nick,
        criadoEm: agora,
        expiraEm,
        usado: false
      });

    const deepLink = `${APP_SCHEME}://login?codigo=${encodeURIComponent(codigo)}`;
    const intentUrl =
      `intent://login?codigo=${encodeURIComponent(codigo)}` +
      `#Intent;scheme=${APP_SCHEME};package=${APP_PACKAGE};end`;

    return res.status(201).json({
      criado: true,
      expiraEm,
      deepLink,
      intentUrl,
      appPackage: APP_PACKAGE
    });
  } catch (error) {
    return responderErro(res, error);
  }
});

// Esta rota ficará pronta para a próxima etapa na Unity.
// O jogo recebe o código do deep link e troca por dados básicos da conta uma única vez.
app.post("/api/trocar-codigo-login-app", async (req, res) => {
  res.set("Cache-Control", "no-store");

  if (!firebaseDb) {
    return res.status(503).json({
      autenticado: false,
      erro: "Servidor de login indisponível."
    });
  }

  const codigo = normalizarCodigoLogin(req.body?.codigo);
  if (!codigo) {
    return res.status(400).json({
      autenticado: false,
      erro: "Código de login inválido."
    });
  }

  const codigoHash = criarHash(codigo);
  const codigoRef = firebaseDb.ref(
    `${FIREBASE_LOGIN_APP_PATH}/CODIGOS/${codigoHash}`
  );
  let resultado = "invalido";

  try {
    const transacao = await codigoRef.transaction((registroAtual) => {
      if (!registroAtual) {
        resultado = "invalido";
        return;
      }

      if (registroAtual.usado === true) {
        resultado = "usado";
        return;
      }

      if (Number(registroAtual.expiraEm) <= Date.now()) {
        resultado = "expirado";
        return;
      }

      resultado = "aceito";
      return {
        ...registroAtual,
        usado: true,
        usadoEm: Date.now()
      };
    }, undefined, false);

    if (!transacao.committed || resultado !== "aceito") {
      const mensagens = {
        usado: "Este código de login já foi utilizado.",
        expirado: "Este código de login expirou.",
        invalido: "Código de login não encontrado."
      };

      return res.status(resultado === "usado" ? 409 : 401).json({
        autenticado: false,
        erro: mensagens[resultado] || mensagens.invalido
      });
    }

    const registro = transacao.snapshot.val();
    return res.json({
      autenticado: true,
      uid: registro.uid,
      nick: registro.nick
    });
  } catch (error) {
    console.error("Erro ao trocar código do app:", resumirErro(error));
    return res.status(502).json({
      autenticado: false,
      erro: "Não foi possível concluir o login agora."
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`DayZombi Login ativo na porta ${PORT}.`);
  console.log(`Firebase Admin: ${firebaseDb && firebaseAuth ? "configurado" : "não configurado"}`);
  console.log(`Aplicativo Android: ${APP_PACKAGE}`);
  console.log(`Deep link: ${APP_SCHEME}://login`);
});

async function obterUsuarioAutenticado(req) {
  if (!firebaseAuth) {
    const erro = new Error("Firebase Authentication não está configurado no servidor.");
    erro.statusCode = 503;
    throw erro;
  }

  const cabecalho = String(req.headers.authorization || "");
  const match = cabecalho.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    const erro = new Error("Entre com sua conta Google para continuar.");
    erro.statusCode = 401;
    throw erro;
  }

  try {
    const token = await firebaseAuth.verifyIdToken(match[1]);
    return {
      uid: token.uid,
      email: sanitizarEmail(token.email),
      nome: sanitizarNome(token.name || ""),
      foto: normalizarUrlExterna(token.picture || ""),
      provedor: limparTexto(token.firebase?.sign_in_provider || "google.com", 40),
      emailVerificado: Boolean(token.email_verified)
    };
  } catch {
    const erro = new Error("Sua sessão expirou. Entre novamente com o Google.");
    erro.statusCode = 401;
    throw erro;
  }
}

function normalizarNickConta(valor) {
  const nick = String(valor || "")
    .normalize("NFKC")
    .trim();

  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,19}$/.test(nick)) {
    return null;
  }

  return {
    nick,
    nickKey: nick.toLowerCase()
  };
}

function normalizarCodigoLogin(valor) {
  const codigo = String(valor || "").trim();
  return /^[A-Za-z0-9_-]{40,80}$/.test(codigo) ? codigo : "";
}

function criarHash(valor) {
  return crypto.createHash("sha256").update(String(valor)).digest("hex");
}

function contaPublica(conta) {
  const dados = clonarObjeto(conta?.Dados);
  const resumo = clonarObjeto(conta?.Eventos?.Resumo);
  return {
    nick: dados.nick || null,
    criadoEm: Number(dados.criadoEm) || null,
    ultimoLoginEm: Number(dados.ultimoLoginEm) || null,
    eventos: {
      valorDoado: arredondarDinheiro(resumo.valorDoado),
      totalContribuido: arredondarDinheiro(resumo.totalContribuido),
      comprouAcessoTeste: Boolean(resumo.comprouAcessoTeste),
      dataCompraAcessoTeste: Number(resumo.dataCompraAcessoTeste) || null,
      quantidadeDoacoes: Number(resumo.quantidadeDoacoes) || 0
    }
  };
}

function usuarioPublico(usuario) {
  return {
    uid: usuario.uid,
    email: usuario.email || null,
    nome: usuario.nome || null,
    foto: usuario.foto || null,
    provedor: usuario.provedor || null,
    emailVerificado: Boolean(usuario.emailVerificado)
  };
}

function responderErro(res, error) {
  const status = Number(error?.statusCode) || 500;
  if (status >= 500) {
    console.error("Erro do servidor:", resumirErro(error));
  }
  return res.status(status).json({
    erro: error?.message || "Ocorreu um erro inesperado."
  });
}

function carregarCredencialFirebase() {
  const jsonBruto = String(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON || ""
  ).trim();

  if (jsonBruto) {
    let conteudo = jsonBruto;
    if (!conteudo.startsWith("{")) {
      conteudo = Buffer.from(conteudo, "base64").toString("utf8");
    }

    const serviceAccount = JSON.parse(conteudo);
    serviceAccount.private_key = String(serviceAccount.private_key || "")
      .replace(/\\n/g, "\n");
    return cert(serviceAccount);
  }

  const projectId = String(process.env.FIREBASE_PROJECT_ID || "").trim();
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || "").trim();
  const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || "")
    .replace(/\\n/g, "\n")
    .trim();

  if (projectId && clientEmail && privateKey) {
    return cert({ projectId, clientEmail, privateKey });
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return applicationDefault();
  }

  return null;
}

function sanitizarEmail(valor) {
  const email = String(valor || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 254) : "";
}

function sanitizarNome(valor) {
  return limparTexto(valor, 100);
}

function limparTexto(valor, limite = 200) {
  return String(valor || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limite);
}

function normalizarUrlExterna(valor) {
  const texto = String(valor || "").trim();
  if (!texto) return "";
  try {
    const url = new URL(texto);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function normalizarUrlPublica(valor) {
  return normalizarUrlExterna(valor).replace(/\/$/, "");
}

function normalizarScheme(valor) {
  const scheme = String(valor || "").trim().toLowerCase();
  return /^[a-z][a-z0-9+.-]{1,30}$/.test(scheme) ? scheme : "dayzombi";
}

function clonarObjeto(valor) {
  return valor && typeof valor === "object" && !Array.isArray(valor)
    ? { ...valor }
    : {};
}

function arredondarDinheiro(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? Math.round(numero * 100) / 100 : 0;
}

function resumirErro(error) {
  return error?.stack || error?.message || String(error);
}
