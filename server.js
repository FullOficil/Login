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
const FIREBASE_LOJA_PATH = "LojaDayZombi";
const APP_PACKAGE = String(
  process.env.APP_PACKAGE || "com.vertexSZ.DayZombi"
).trim();
const APP_SCHEME = normalizarScheme(process.env.APP_SCHEME || "dayzombi");
const CODIGO_LOGIN_TTL_MS = 5 * 60 * 1000;
const SESSAO_EDITOR_TTL_MS = 5 * 60 * 1000;

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
// No Android, o código vai pelo deep link. No Unity Editor, o Editor consulta
// uma sessão temporária aleatória até o navegador concluir o login.
app.post("/api/criar-codigo-login-app", async (req, res) => {
  res.set("Cache-Control", "no-store");

  if (!firebaseDb) {
    return res.status(503).json({
      criado: false,
      erro: "Servidor de login do aplicativo indisponível."
    });
  }

  const sessaoEditorBruta = String(req.body?.sessaoEditor || "").trim();
  const sessaoEditor = normalizarSessaoEditor(sessaoEditorBruta);

  if (sessaoEditorBruta && !sessaoEditor) {
    return res.status(400).json({
      criado: false,
      erro: "Sessão do Unity Editor inválida."
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
    const sessaoHash = sessaoEditor ? criarHash(sessaoEditor) : null;

    const registroCodigo = {
      uid: usuario.uid,
      nick: conta.Dados.nick,
      criadoEm: agora,
      expiraEm,
      usado: false,
      sessaoEditorHash: sessaoHash
    };

    // O código usa somente caracteres permitidos em chaves do Realtime Database
    // (A-Z, a-z, 0-9, _ e -). Salvamos pelo próprio código para eliminar qualquer
    // divergência entre o identificador salvo na criação e o consultado na troca.
    // A gravação multipath é atômica: código e sessão do Editor aparecem juntos.
    const atualizacoes = {
      [`${FIREBASE_LOGIN_APP_PATH}/CODIGOS/${codigo}`]: registroCodigo
    };

    if (sessaoHash) {
      atualizacoes[
        `${FIREBASE_LOGIN_APP_PATH}/EDITOR_SESSOES/${sessaoHash}`
      ] = {
        codigo,
        criadoEm: agora,
        expiraEm: Math.min(expiraEm, agora + SESSAO_EDITOR_TTL_MS)
      };
    }

    await firebaseDb.ref().update(atualizacoes);

    const deepLink = `${APP_SCHEME}://login?codigo=${encodeURIComponent(codigo)}`;
    const intentUrl =
      `intent://login?codigo=${encodeURIComponent(codigo)}` +
      `#Intent;scheme=${APP_SCHEME};package=${APP_PACKAGE};end`;

    return res.status(201).json({
      criado: true,
      expiraEm,
      modoEditor: Boolean(sessaoEditor),
      deepLink,
      intentUrl,
      appPackage: APP_PACKAGE
    });
  } catch (error) {
    return responderErro(res, error);
  }
});

// O Unity Editor não recebe deep links Android. Durante o Play Mode ele consulta
// esta rota usando uma sessão aleatória conhecida apenas pelo Editor e pelo site.
app.get("/api/consultar-login-editor", async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  if (!firebaseDb) {
    return res.status(503).json({
      pronto: false,
      erro: "Servidor de login do Editor indisponível."
    });
  }

  const sessao = normalizarSessaoEditor(req.query?.sessao);
  if (!sessao) {
    return res.status(400).json({
      pronto: false,
      erro: "Sessão do Unity Editor inválida."
    });
  }

  const sessaoRef = firebaseDb.ref(
    `${FIREBASE_LOGIN_APP_PATH}/EDITOR_SESSOES/${criarHash(sessao)}`
  );

  try {
    const snapshot = await sessaoRef.once("value");
    const registro = snapshot.val();

    // Enquanto o navegador ainda não terminou o login, a sessão não existe.
    if (!registro) {
      return res.json({ pronto: false });
    }

    if (Number(registro.expiraEm) <= Date.now()) {
      await sessaoRef.remove().catch(() => {});
      return res.status(410).json({
        pronto: false,
        erro: "A sessão de login do Unity Editor expirou."
      });
    }

    if (!registro.codigo) {
      return res.json({ pronto: false });
    }

    // Não marcamos a sessão como entregue aqui. Assim, se o Editor perder uma
    // resposta HTTP ao trocar de foco, ele pode consultar novamente sem travar.
    return res.json({
      pronto: true,
      codigo: registro.codigo
    });
  } catch (error) {
    console.error("Erro ao consultar login do Editor:", resumirErro(error));
    return res.status(502).json({
      pronto: false,
      erro: "Não foi possível consultar o login do Editor agora."
    });
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
  const codigoRefDireto = firebaseDb.ref(
    `${FIREBASE_LOGIN_APP_PATH}/CODIGOS/${codigo}`
  );

  // Compatibilidade com os códigos criados pela versão anterior, que usava
  // SHA-256 como nome do nó. Códigos novos usam o próprio valor como chave.
  const codigoRefLegado = firebaseDb.ref(
    `${FIREBASE_LOGIN_APP_PATH}/CODIGOS/${codigoHash}`
  );

  const usoRef = firebaseDb.ref(
    `${FIREBASE_LOGIN_APP_PATH}/CODIGOS_USADOS/${codigoHash}`
  );

  let codigoRef = codigoRefDireto;
  let codigoPath = `${FIREBASE_LOGIN_APP_PATH}/CODIGOS/${codigo}`;
  let registro = null;
  let usoReservado = false;

  try {
    let snapshot = await codigoRefDireto.once("value");

    if (!snapshot.exists()) {
      snapshot = await codigoRefLegado.once("value");
      codigoRef = codigoRefLegado;
      codigoPath = `${FIREBASE_LOGIN_APP_PATH}/CODIGOS/${codigoHash}`;
    }

    registro = snapshot.val();

    if (!registro) {
      console.warn(
        `[Login App] Código não encontrado. hash=${codigoHash.slice(0, 12)}`
      );
      return res.status(401).json({
        autenticado: false,
        erro: "Código de login não encontrado."
      });
    }

    if (Number(registro.expiraEm) <= Date.now()) {
      await codigoRef.remove().catch(() => {});
      return res.status(401).json({
        autenticado: false,
        erro: "Este código de login expirou."
      });
    }

    if (registro.usado === true) {
      return res.status(409).json({
        autenticado: false,
        erro: "Este código de login já foi utilizado."
      });
    }

    // Reserva atômica do uso. Mesmo que duas requisições cheguem juntas, somente
    // uma consegue criar o marcador. A leitura do código acontece antes, evitando
    // o problema observado com transaction() diretamente no nó do código.
    const reserva = await usoRef.transaction((usoAtual) => {
      const agoraReserva = Date.now();
      if (usoAtual && Number(usoAtual.expiraEm) > agoraReserva) return;
      return {
        usadoEm: agoraReserva,
        expiraEm: Number(registro.expiraEm) || agoraReserva + CODIGO_LOGIN_TTL_MS,
        uid: registro.uid || null
      };
    }, undefined, false);

    if (!reserva.committed) {
      return res.status(409).json({
        autenticado: false,
        erro: "Este código de login já foi utilizado."
      });
    }

    usoReservado = true;

    // A conta autenticada e a compra são consultadas apenas no servidor.
    // O jogo recebe somente o resultado necessário para liberar ou bloquear o teste.
    const [contaSnapshot, acessoSnapshot] = await Promise.all([
      firebaseDb
        .ref(`${FIREBASE_LOGINS_PATH}/USUARIOS/${registro.uid}/Dados`)
        .once("value"),
      firebaseDb
        .ref(`${FIREBASE_LOJA_PATH}/Usuarios/${registro.uid}/AcessoTeste`)
        .once("value")
    ]);

    const dadosConta = contaSnapshot.val() || {};
    const acesso = acessoSnapshot.val() || {};
    const possuiChave =
      typeof acesso.chave === "string" && acesso.chave.trim().length > 10;
    const temAcessoTeste = Boolean(
      acesso.comprado === true &&
      acesso.ativo === true &&
      possuiChave
    );

    const remocoes = {
      [codigoPath]: null
    };

    if (registro.sessaoEditorHash) {
      remocoes[
        `${FIREBASE_LOGIN_APP_PATH}/EDITOR_SESSOES/${registro.sessaoEditorHash}`
      ] = null;
    }

    // O marcador CODIGOS_USADOS permanece durante o TTL para impedir reutilização.
    // O código e a sessão do Editor são apagados somente após a resposta estar pronta.
    await firebaseDb.ref().update(remocoes);

    return res.json({
      autenticado: true,
      uid: registro.uid,
      nick: dadosConta.nick || registro.nick || null,
      temAcessoTeste,
      possuiChave,
      acessoAtivo: acesso.ativo === true,
      compradoEm: Number(acesso.compradoEm) || null,
      mensagem: temAcessoTeste
        ? "Conta conectada. Acesso aos testes liberado."
        : "Conta conectada, mas sem acesso ativo aos testes."
    });
  } catch (error) {
    // Se a falha aconteceu depois da reserva, liberamos o marcador para permitir
    // uma nova tentativa com o mesmo código enquanto ele ainda estiver válido.
    if (usoReservado) {
      await usoRef.remove().catch(() => {});
    }

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

function normalizarSessaoEditor(valor) {
  const sessao = String(valor || "").trim();
  return /^[A-Za-z0-9_-]{32,128}$/.test(sessao) ? sessao : "";
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
