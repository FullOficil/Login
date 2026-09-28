"use strict";

require("dotenv").config();

const crypto = require("crypto");
const https = require("https");
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
const LOJA_URL =
  normalizarUrlPublica(
    process.env.LOJA_URL || "https://loja-dayzombi.onrender.com"
  ) || "https://loja-dayzombi.onrender.com";
const APP_PACKAGE = String(
  process.env.APP_PACKAGE || "com.vertexSZ.DayZombi"
).trim();

// Quantidade de Títulos é decidida NO SERVIDOR.
// Para os IDs no formato usado pelo projeto, por exemplo:
//   pacote_100_titulos      -> 100
//   pacote_1000_bonus_100   -> 1100
// Também é possível sobrescrever/adicionar IDs pelo Render com:
// TITULOS_PRODUTOS_JSON={"meu_produto":500}
const TITULOS_PRODUTOS = carregarProdutosTitulosDoAmbiente();
const GOOGLE_PLAY_OAUTH_SCOPE =
  "https://www.googleapis.com/auth/androidpublisher";
let googlePlayAccessTokenCache = {
  token: "",
  expiraEm: 0
};
const APP_SCHEME = normalizarScheme(process.env.APP_SCHEME || "dayzombi");
const CODIGO_LOGIN_TTL_MS = 5 * 60 * 1000;
const SESSAO_EDITOR_TTL_MS = 5 * 60 * 1000;
const ATUALIZACAO_ULTIMO_LOGIN_INTERVALO_MS = 60 * 1000;

// Sessão automática do jogo. O token é assinado no servidor e fica salvo somente
// no dispositivo. Ele NÃO é armazenado no Realtime Database.
// LOGIN_SESSION_SECRET é opcional: se não existir, derivamos uma chave estável
// das credenciais privadas do Firebase já configuradas no Render.
const LOGIN_SESSION_TTL_DIAS = Math.max(
  1,
  Math.min(365, Number(process.env.LOGIN_SESSION_TTL_DIAS) || 30)
);
const LOGIN_SESSION_TTL_MS = LOGIN_SESSION_TTL_DIAS * 24 * 60 * 60 * 1000;
const LOGIN_SESSION_SECRET_ORIGEM = String(
  process.env.LOGIN_SESSION_SECRET ||
  process.env.FIREBASE_PRIVATE_KEY ||
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
  ""
).trim();
const LOGIN_SESSION_SECRET = LOGIN_SESSION_SECRET_ORIGEM
  ? crypto
      .createHash("sha256")
      .update(`dayzombi-login-session-v1|${LOGIN_SESSION_SECRET_ORIGEM}`)
      .digest("hex")
  : "";
const LOGIN_SESSION_DISPONIVEL = LOGIN_SESSION_SECRET.length >= 32;

// CHAVE DE ACESSO DESATIVADA POR ENQUANTO.
// false = qualquer conta Google autenticada pode continuar sem consultar chave/loja.
// true  = restaura a verificação antiga de AcessoTeste/Custom Claims.
const EXIGIR_CHAVE_ACESSO = false;

// O acesso ao teste fica espelhado em Custom Claims do Firebase Auth.
// Depois da primeira sincronização, o login não precisa consultar o
// Realtime Database apenas para descobrir se a conta possui a chave.
const CLAIM_ACESSO_TESTE = "dzAcessoTeste";
const CLAIM_ACESSO_SINCRONIZADO_EM = "dzAcessoSyncEm";
const CLAIM_ACESSO_COMPRADO_EM = "dzAcessoCompradoEm";
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
    loginAutomaticoDisponivel: LOGIN_SESSION_DISPONIVEL,
    loginAutomaticoDias: LOGIN_SESSION_TTL_DIAS,
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
    appScheme: APP_SCHEME,
    lojaUrl: LOJA_URL
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

    // Quando a chave está desativada, NÃO consulta LojaDayZombi/AcessoTeste
    // e NÃO sincroniza Custom Claims. O login segue normalmente.
    const acessoTeste = EXIGIR_CHAVE_ACESSO
      ? await obterStatusAcessoTesteAutenticado(usuario)
      : {
          temAcessoTeste: true,
          possuiChave: true,
          acessoAtivo: true,
          compradoEm: null,
          claimsAtualizadas: false
        };

    // Este bloqueio só existe quando a exigência de chave estiver ligada.
    if (EXIGIR_CHAVE_ACESSO && !acessoTeste.temAcessoTeste) {
      return res.json({
        autenticado: true,
        cadastrado: false,
        usuario: usuarioPublico(usuario),
        temAcessoTeste: false,
        possuiChave: acessoTeste.possuiChave,
        acessoAtivo: acessoTeste.acessoAtivo,
        claimsAtualizadas: acessoTeste.claimsAtualizadas === true,
        lojaUrl: LOJA_URL
      });
    }

    // O login só precisa dos dados básicos da conta. Ler o UID inteiro também
    // baixaria Eventos/Pagamentos e qualquer outro conteúdo acumulado abaixo
    // do usuário, aumentando o tráfego sem necessidade.
    const dadosRef = firebaseDb.ref(
      `${FIREBASE_LOGINS_PATH}/USUARIOS/${usuario.uid}/Dados`
    );
    const snapshot = await dadosRef.once("value");
    const dadosAtuais = snapshot.val() || {};

    if (!dadosAtuais.nick) {
      return res.json({
        autenticado: true,
        cadastrado: false,
        usuario: usuarioPublico(usuario),
        temAcessoTeste: true,
        possuiChave: acessoTeste.possuiChave,
        acessoAtivo: acessoTeste.acessoAtivo,
        claimsAtualizadas: acessoTeste.claimsAtualizadas === true,
        lojaUrl: LOJA_URL
      });
    }

    const agora = Date.now();
    const dadosDesejados = {
      googleEmail: usuario.email || dadosAtuais.googleEmail || "",
      googleNome: usuario.nome || dadosAtuais.googleNome || "",
      googleFoto: usuario.foto || dadosAtuais.googleFoto || "",
      provedor: usuario.provedor || dadosAtuais.provedor || "google.com",
      emailVerificado: Boolean(usuario.emailVerificado)
    };

    const perfilMudou =
      dadosDesejados.googleEmail !== (dadosAtuais.googleEmail || "") ||
      dadosDesejados.googleNome !== (dadosAtuais.googleNome || "") ||
      dadosDesejados.googleFoto !== (dadosAtuais.googleFoto || "") ||
      dadosDesejados.provedor !== (dadosAtuais.provedor || "google.com") ||
      dadosDesejados.emailVerificado !== Boolean(dadosAtuais.emailVerificado);

    const ultimoLoginAtual = Number(dadosAtuais.ultimoLoginEm) || 0;
    const deveAtualizarUltimoLogin =
      agora - ultimoLoginAtual >= ATUALIZACAO_ULTIMO_LOGIN_INTERVALO_MS;

    let dadosRetorno = { ...dadosAtuais };

    // Evita uma escrita no Firebase a cada GET /api/minha-conta.
    // Atualiza imediatamente se o perfil Google mudou; caso contrário,
    // ultimoLoginEm é persistido no máximo uma vez por minuto por usuário.
    if (perfilMudou || deveAtualizarUltimoLogin) {
      const alteracoes = {
        ...dadosDesejados,
        atualizadoEm: agora
      };

      if (deveAtualizarUltimoLogin) {
        alteracoes.ultimoLoginEm = agora;
      }

      await dadosRef.update(alteracoes);
      dadosRetorno = {
        ...dadosAtuais,
        ...alteracoes
      };
    }

    return res.json({
      autenticado: true,
      cadastrado: true,
      usuario: usuarioPublico(usuario),
      // A interface de login usa apenas os dados básicos da conta. Não buscamos
      // Eventos/Resumo aqui para evitar uma segunda leitura desnecessária.
      conta: contaPublicaLogin(dadosRetorno),
      temAcessoTeste: acessoTeste.temAcessoTeste,
      possuiChave: acessoTeste.possuiChave,
      acessoAtivo: acessoTeste.acessoAtivo,
      claimsAtualizadas: acessoTeste.claimsAtualizadas === true,
      lojaUrl: LOJA_URL
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

  let nickRef = null;
  let reservaId = null;
  let reservaCriadaPorEstaRequisicao = false;

  try {
    const usuario = await obterUsuarioAutenticado(req);
    const nickInfo = normalizarNickConta(req.body?.nick);

    if (!nickInfo) {
      return res.status(400).json({
        cadastrado: false,
        erro: "Use de 3 a 20 caracteres: letras, números, _ ou -. O Nick deve começar com letra ou número."
      });
    }

    const contaRef = firebaseDb.ref(
      `${FIREBASE_LOGINS_PATH}/USUARIOS/${usuario.uid}`
    );
    const dadosRef = contaRef.child("Dados");

    // Para descobrir se a conta já existe, basta ler /Dados. Isso evita baixar
    // Eventos/Pagamentos e outros dados históricos do usuário.
    const contaExistenteSnapshot = await dadosRef.once("value");
    const dadosExistentes = contaExistenteSnapshot.val() || {};

    if (dadosExistentes.nick) {
      const contaExistente = { Dados: dadosExistentes };
      await garantirIndicesDaConta(usuario.uid, contaExistente).catch((error) => {
        console.warn(
          "Não foi possível reparar os índices da conta existente:",
          resumirErro(error)
        );
      });

      return res.status(201).json({
        autenticado: true,
        cadastrado: true,
        usuario: usuarioPublico(usuario),
        conta: contaPublicaLogin(dadosExistentes)
      });
    }

    const agora = Date.now();
    reservaId = crypto.randomUUID();
    nickRef = firebaseDb.ref(
      `${FIREBASE_LOGINS_PATH}/NICKS/${nickInfo.nickKey}`
    );

    // A transação ocorre SOMENTE no Nick desejado.
    // Usuários cadastrando Nicks diferentes não disputam mais o nó inteiro
    // LOGINS_REGISTRADOS, eliminando a principal fonte de maxretry.
    const reservaNick = await nickRef.transaction((registroAtual) => {
      if (registroAtual?.uid && registroAtual.uid !== usuario.uid) {
        return;
      }

      if (registroAtual?.uid === usuario.uid) {
        return registroAtual;
      }

      return {
        uid: usuario.uid,
        nick: nickInfo.nick,
        criadoEm: agora,
        reservaId
      };
    }, undefined, false);

    if (!reservaNick.committed) {
      return res.status(409).json({
        cadastrado: false,
        erro: "Esse Nick já está sendo usado. Escolha outro."
      });
    }

    reservaCriadaPorEstaRequisicao =
      reservaNick.snapshot.val()?.reservaId === reservaId;

    const contaNova = {
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
        atualizadoEm: agora,
        Titulos: 0
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

    // Esta segunda transação é isolada por UID. Só duas requisições do MESMO
    // usuário podem disputar esse caminho; cadastros de usuários diferentes
    // não interferem entre si.
    const transacaoConta = await contaRef.transaction((contaAtual) => {
      if (contaAtual?.Dados?.nick) {
        return contaAtual;
      }

      return contaNova;
    }, undefined, false);

    if (!transacaoConta.committed) {
      return res.status(500).json({
        cadastrado: false,
        erro: "Não foi possível registrar a conta agora."
      });
    }

    const contaFinal = transacaoConta.snapshot.val();
    const nickFinalKey = String(contaFinal?.Dados?.nickChave || "").toLowerCase();

    // Protege contra duas requisições simultâneas do mesmo usuário tentando
    // cadastrar Nicks diferentes. Somente o Nick realmente salvo na conta fica
    // reservado; a reserva perdedora é liberada.
    if (nickFinalKey !== nickInfo.nickKey) {
      if (reservaCriadaPorEstaRequisicao) {
        await liberarReservaNickSeForDoUsuario(
          nickRef,
          usuario.uid,
          reservaId
        );
      }

      await garantirIndicesDaConta(usuario.uid, contaFinal).catch((error) => {
        console.warn(
          "Não foi possível reparar os índices após cadastro concorrente:",
          resumirErro(error)
        );
      });

      return res.status(201).json({
        autenticado: true,
        cadastrado: true,
        usuario: usuarioPublico(usuario),
        conta: contaPublica(contaFinal)
      });
    }

    // Mantém os índices auxiliares sincronizados sem transacionar a árvore toda.
    // O update multipath é atômico.
    await firebaseDb.ref().update({
      [`${FIREBASE_LOGINS_PATH}/NICKS/${nickInfo.nickKey}`]: {
        uid: usuario.uid,
        nick: nickInfo.nick,
        criadoEm: Number(reservaNick.snapshot.val()?.criadoEm) || agora
      },
      [`${FIREBASE_LOGINS_PATH}/UID_PARA_NICK/${usuario.uid}`]: {
        nickChave: nickInfo.nickKey,
        nick: nickInfo.nick
      }
    });

    return res.status(201).json({
      autenticado: true,
      cadastrado: true,
      usuario: usuarioPublico(usuario),
      conta: contaPublica(contaFinal)
    });
  } catch (error) {
    // Não apagamos a reserva automaticamente em uma falha de rede/servidor.
    // Isso evita que uma segunda requisição simultânea do mesmo usuário conclua
    // a conta e tenha o índice do Nick removido pela primeira requisição.
    // Na próxima tentativa, o mesmo UID pode reutilizar a reserva normalmente.
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

    // Com EXIGIR_CHAVE_ACESSO=false, não faz nenhuma leitura de chave.
    const acessoTeste = EXIGIR_CHAVE_ACESSO
      ? await obterStatusAcessoTesteAutenticado(usuario)
      : {
          temAcessoTeste: true,
          possuiChave: true,
          acessoAtivo: true,
          compradoEm: null,
          claimsAtualizadas: false
        };

    if (EXIGIR_CHAVE_ACESSO && !acessoTeste.temAcessoTeste) {
      return res.status(403).json({
        criado: false,
        precisaChave: true,
        possuiChave: acessoTeste.possuiChave,
        acessoAtivo: acessoTeste.acessoAtivo,
        lojaUrl: LOJA_URL,
        erro: "É necessário obter uma chave de acesso nesta conta para entrar no DayZombi."
      });
    }

    // Para gerar o código temporário só precisamos do Nick. Ler somente este
    // campo reduz o download ao mínimo possível.
    const nickSnapshot = await firebaseDb
      .ref(`${FIREBASE_LOGINS_PATH}/USUARIOS/${usuario.uid}/Dados/nick`)
      .once("value");
    const nick = String(nickSnapshot.val() || "").trim();

    if (!nick) {
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
      nick,
      foto: usuario.foto || "",
      temAcessoTeste: true,
      possuiChave: true,
      acessoAtivo: true,
      compradoEm: Number(acessoTeste.compradoEm) || null,
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
    // Mantido apenas para compatibilidade. Não informa package= para impedir
    // que o navegador redirecione para a Play Store quando o APK ainda não
    // estiver instalado ou quando o intent-filter estiver ausente.
    const intentUrl =
      `intent://login?codigo=${encodeURIComponent(codigo)}` +
      `#Intent;scheme=${APP_SCHEME};end`;

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

  const idDispositivo = normalizarIdDispositivo(req.body?.idDispositivo);
  if (!idDispositivo) {
    return res.status(400).json({
      autenticado: false,
      erro: "Identificador do dispositivo inválido."
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

    // Consulta somente o campo de banimento, não o nó inteiro da conta.
    const banimentoRef = firebaseDb.ref(
      `${FIREBASE_LOGINS_PATH}/USUARIOS/${registro.uid}/Dados/banimento`
    );
    const banimentoSnapshot = await banimentoRef.once("value");

    if (banimentoSnapshot.val() === true) {
      return res.status(403).json({
        autenticado: false,
        banido: true,
        erro: "Este dispositivo/conta está bloqueado."
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

    // Com a verificação de chave desligada, qualquer código de login válido
    // recebe acesso sem consultar LojaDayZombi/AcessoTeste.
    let nickConta = limparNickPublico(registro.nick || "");
    let temAcessoTeste = true;
    let possuiChave = true;
    let acessoAtivo = true;
    let compradoEm = null;

    if (EXIGIR_CHAVE_ACESSO) {
      temAcessoTeste = registro.temAcessoTeste === true;
      possuiChave = registro.possuiChave === true;
      acessoAtivo = registro.acessoAtivo === true;
      compradoEm = Number(registro.compradoEm) || null;

      // Compatibilidade temporária com códigos criados pela versão anterior.
      if (typeof registro.temAcessoTeste !== "boolean") {
        const acessoLegado = await obterStatusAcessoTeste(registro.uid);
        temAcessoTeste = acessoLegado.temAcessoTeste;
        possuiChave = acessoLegado.possuiChave;
        acessoAtivo = acessoLegado.acessoAtivo;
        compradoEm = acessoLegado.compradoEm;
      }
    }

    if (!nickConta) {
      const nickSnapshot = await firebaseDb
        .ref(`${FIREBASE_LOGINS_PATH}/USUARIOS/${registro.uid}/Dados/nick`)
        .once("value");
      nickConta = limparNickPublico(nickSnapshot.val() || "");
    }

    // O registro do dispositivo acontece apenas quando o navegador conclui um
    // login real. No login automático não regravamos este campo toda vez.
    const dadosDispositivo = {
      idDispositivo
    };
    if (!banimentoSnapshot.exists()) {
      dadosDispositivo.banimento = false;
    }

    await firebaseDb
      .ref(`${FIREBASE_LOGINS_PATH}/USUARIOS/${registro.uid}/Dados`)
      .update(dadosDispositivo);

    const sessaoAssinada = criarTokenSessaoApp({
      uid: registro.uid,
      nick: nickConta,
      foto: registro.foto || "",
      idDispositivo
    });

    // Token temporário do Firebase Auth para o Unity autenticar diretamente
    // no Firebase. O jogo troca este token por uma sessão Firebase normal.
    const firebaseCustomToken = await criarFirebaseCustomToken(registro.uid);

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
      nick: nickConta || null,
      foto: normalizarUrlExterna(registro.foto || "") || null,
      tokenSessao: sessaoAssinada?.token || null,
      firebaseCustomToken,
      sessaoExpiraEm: sessaoAssinada?.expiraEm || null,
      loginAutomaticoDisponivel: Boolean(sessaoAssinada),
      temAcessoTeste,
      possuiChave,
      acessoAtivo,
      compradoEm,
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

// Login automático depois do primeiro acesso.
// O token é validado por assinatura HMAC e vinculado ao dispositivo.
// Não há leitura do perfil inteiro: consultamos somente /Dados/banimento.
app.post("/api/login-automatico", async (req, res) => {
  res.set("Cache-Control", "no-store");

  if (!firebaseDb) {
    return res.status(503).json({
      autenticado: false,
      erro: "Servidor de login indisponível."
    });
  }

  const idDispositivo = normalizarIdDispositivo(req.body?.idDispositivo);
  const tokenSessao = String(req.body?.tokenSessao || "").trim();

  if (!idDispositivo || !tokenSessao) {
    return res.status(400).json({
      autenticado: false,
      apagarSessao: true,
      erro: "Sessão automática incompleta."
    });
  }

  try {
    const sessao = validarTokenSessaoApp(tokenSessao, idDispositivo);

    // Mantemos a checagem de banimento no servidor. É apenas uma leitura de um
    // campo booleano; UID, Nick e foto vêm do token assinado.
    const banimentoSnapshot = await firebaseDb
      .ref(`${FIREBASE_LOGINS_PATH}/USUARIOS/${sessao.uid}/Dados/banimento`)
      .once("value");

    if (banimentoSnapshot.val() === true) {
      return res.status(403).json({
        autenticado: false,
        apagarSessao: true,
        banido: true,
        erro: "Esta conta está bloqueada."
      });
    }

    // Renova a sessão sem acessar outros dados do Realtime Database.
    const sessaoRenovada = criarTokenSessaoApp({
      uid: sessao.uid,
      nick: sessao.nick,
      foto: sessao.foto,
      idDispositivo
    });

    // Gera um Custom Token novo a cada login automático. Assim o Unity
    // consegue restaurar também a autenticação do Firebase sem novo login Google.
    const firebaseCustomToken = await criarFirebaseCustomToken(sessao.uid);

    return res.json({
      autenticado: true,
      automatico: true,
      uid: sessao.uid,
      nick: sessao.nick || null,
      foto: sessao.foto || null,
      tokenSessao: sessaoRenovada?.token || tokenSessao,
      firebaseCustomToken,
      sessaoExpiraEm: sessaoRenovada?.expiraEm || sessao.expiraEm,
      loginAutomaticoDisponivel: true,
      temAcessoTeste: true,
      possuiChave: true,
      acessoAtivo: true,
      compradoEm: null,
      mensagem: "Login automático concluído."
    });
  } catch (error) {
    const status = Number(error?.statusCode) || 401;
    return res.status(status).json({
      autenticado: false,
      apagarSessao: status === 401,
      erro: error?.message || "Não foi possível validar a sessão salva."
    });
  }
});

async function criarFirebaseCustomToken(uid) {
  const uidNormalizado = String(uid || "").trim();

  if (!firebaseAuth || !uidNormalizado) {
    const error = new Error(
      "Firebase Auth indisponível para gerar o token do aplicativo."
    );
    error.statusCode = 503;
    throw error;
  }

  return firebaseAuth.createCustomToken(uidNormalizado);
}

async function liberarReservaNickSeForDoUsuario(nickRef, uid, reservaId) {
  if (!nickRef || !uid || !reservaId) return;

  await nickRef.transaction((registroAtual) => {
    if (
      registroAtual?.uid === uid &&
      registroAtual?.reservaId === reservaId
    ) {
      return null;
    }

    return registroAtual;
  }, undefined, false);
}

async function garantirIndicesDaConta(uid, conta) {
  const nick = String(conta?.Dados?.nick || "").trim();
  const nickChave = String(
    conta?.Dados?.nickChave || nick.toLowerCase()
  ).trim().toLowerCase();

  if (!uid || !nick || !nickChave) return;

  const nickRef = firebaseDb.ref(
    `${FIREBASE_LOGINS_PATH}/NICKS/${nickChave}`
  );

  const reserva = await nickRef.transaction((registroAtual) => {
    if (registroAtual?.uid && registroAtual.uid !== uid) {
      return;
    }

    return {
      uid,
      nick,
      criadoEm:
        Number(registroAtual?.criadoEm) ||
        Number(conta?.Dados?.criadoEm) ||
        Date.now()
    };
  }, undefined, false);

  if (!reserva.committed) {
    console.error(
      `[Login] Conflito de índice: o Nick ${nickChave} está associado a outro UID.`
    );
    return;
  }

  await firebaseDb
    .ref(`${FIREBASE_LOGINS_PATH}/UID_PARA_NICK/${uid}`)
    .set({
      nickChave,
      nick
    });
}

function limparNickPublico(valor) {
  return String(valor || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 40);
}


// ============================================================================
// COMPRAS DE TÍTULOS - GOOGLE PLAY
// ============================================================================
// O Unity continua usando o GerenciadorDeCompras existente.
// Depois que a compra entra como PendingOrder, o jogo envia productId + recibo.
// O UID vem do Firebase ID Token do NOVO sistema de login.
// O servidor valida a compra na Google Play e só então altera /Dados/Titulos.
app.post("/api/validar-compra-titulos", async (req, res) => {
  res.set("Cache-Control", "no-store");

  if (!firebaseDb || !firebaseAuth) {
    return res.status(503).json({
      sucesso: false,
      erro: "Servidor de compras indisponível."
    });
  }

  try {
    const usuario = await obterUsuarioAutenticado(req);
    const productId = normalizarProductIdGoogle(req.body?.productId);
    const receipt = String(req.body?.receipt || "").trim();

    if (!productId) {
      const error = new Error("Produto da compra inválido.");
      error.statusCode = 400;
      throw error;
    }

    if (!receipt || receipt.length > 90000) {
      const error = new Error("Recibo da compra inválido.");
      error.statusCode = 400;
      throw error;
    }

    const quantidadeBase = obterQuantidadeTitulosProduto(productId);

    if (!Number.isSafeInteger(quantidadeBase) || quantidadeBase <= 0) {
      const error = new Error(
        "Este productId não está configurado para entregar Títulos."
      );
      error.statusCode = 400;
      throw error;
    }

    const reciboGoogle = extrairCompraGoogleDoRecibo(receipt);

    if (reciboGoogle.productId &&
        reciboGoogle.productId !== productId) {
      const error = new Error(
        "O produto do recibo não corresponde ao produto comprado."
      );
      error.statusCode = 400;
      throw error;
    }

    if (reciboGoogle.packageName &&
        reciboGoogle.packageName !== APP_PACKAGE) {
      const error = new Error(
        "O recibo pertence a outro aplicativo."
      );
      error.statusCode = 400;
      throw error;
    }

    const compraGoogle = await validarCompraNoGooglePlay(
      productId,
      reciboGoogle.purchaseToken
    );

    if (Number(compraGoogle.purchaseState) !== 0) {
      const error = new Error(
        "A Google Play ainda não confirmou este pagamento."
      );
      error.statusCode = 409;
      throw error;
    }

    if (compraGoogle.productId &&
        compraGoogle.productId !== productId) {
      const error = new Error(
        "A Google Play retornou um produto diferente do esperado."
      );
      error.statusCode = 400;
      throw error;
    }

    if (compraGoogle.purchaseToken &&
        compraGoogle.purchaseToken !== reciboGoogle.purchaseToken) {
      const error = new Error(
        "O token da compra não corresponde à Google Play."
      );
      error.statusCode = 400;
      throw error;
    }

    const quantidadeCompra = Math.max(
      1,
      Math.trunc(Number(compraGoogle.quantity) || 1)
    );

    const quantidadeTotal = quantidadeBase * quantidadeCompra;

    if (!Number.isSafeInteger(quantidadeTotal) ||
        quantidadeTotal <= 0) {
      const error = new Error(
        "Quantidade de Títulos da compra inválida."
      );
      error.statusCode = 500;
      throw error;
    }

    const purchaseTokenHash =
      criarHash(reciboGoogle.purchaseToken);

    const reserva = await reservarCompraGoogleTitulos({
      purchaseTokenHash,
      uid: usuario.uid,
      productId,
      quantidadeTitulos: quantidadeTotal,
      orderId:
        String(
          compraGoogle.orderId ||
          reciboGoogle.orderId ||
          ""
        ).trim().slice(0, 200),
      purchaseTimeMillis:
        Number(compraGoogle.purchaseTimeMillis) ||
        Number(reciboGoogle.purchaseTimeMillis) ||
        0
    });

    const quantidadeReservada =
      Number(reserva.registro?.quantidadeTitulos);

    const quantidadeParaCreditar =
      Number.isSafeInteger(quantidadeReservada) &&
      quantidadeReservada > 0
        ? quantidadeReservada
        : quantidadeTotal;

    const credito =
      await creditarTitulosGoogleIdempotente({
        uid: usuario.uid,
        purchaseTokenHash,
        productId,
        quantidadeTitulos: quantidadeParaCreditar,
        orderId:
          String(
            compraGoogle.orderId ||
            reciboGoogle.orderId ||
            ""
          ).trim().slice(0, 200)
      });

    await reserva.ref.update({
      status: "creditada",
      creditadoEm: Date.now(),
      novoSaldo: credito.novoSaldo
    }).catch((error) => {
      console.warn(
        "[Compras] Crédito concluído, mas não foi possível finalizar o marcador global:",
        resumirErro(error)
      );
    });

    console.log(
      `[Compras] Títulos validados | uid=${usuario.uid} | ` +
      `produto=${productId} | +${quantidadeParaCreditar} | ` +
      `saldo=${credito.novoSaldo} | repetida=${credito.jaProcessada}`
    );

    return res.json({
      sucesso: true,
      jaProcessada: credito.jaProcessada,
      productId,
      quantidadeTitulos: quantidadeParaCreditar,
      novoSaldo: credito.novoSaldo,
      orderId:
        String(
          compraGoogle.orderId ||
          reciboGoogle.orderId ||
          ""
        ) || null
    });
  } catch (error) {
    const status = Number(error?.statusCode) || 500;

    if (status >= 500) {
      console.error(
        "[Compras] Erro ao validar compra:",
        resumirErro(error)
      );
    } else {
      console.warn(
        "[Compras] Compra recusada:",
        error?.message || String(error)
      );
    }

    return res.status(status).json({
      sucesso: false,
      erro:
        error?.message ||
        "Não foi possível validar a compra agora."
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
      emailVerificado: Boolean(token.email_verified),
      acessoTesteClaim: token[CLAIM_ACESSO_TESTE],
      acessoSincronizadoEmClaim: Number(token[CLAIM_ACESSO_SINCRONIZADO_EM]) || 0,
      acessoCompradoEmClaim: Number(token[CLAIM_ACESSO_COMPRADO_EM]) || 0
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

async function obterStatusAcessoTesteAutenticado(usuario) {
  if (!usuario?.uid) {
    return {
      temAcessoTeste: false,
      possuiChave: false,
      acessoAtivo: false,
      compradoEm: null,
      claimsAtualizadas: false
    };
  }

  // Se a claim já foi sincronizada, nenhuma leitura do Realtime Database é
  // necessária para validar a chave nesta conta.
  if (usuario.acessoSincronizadoEmClaim > 0 &&
      typeof usuario.acessoTesteClaim === "boolean") {
    const liberado = usuario.acessoTesteClaim === true;
    return {
      temAcessoTeste: liberado,
      possuiChave: liberado,
      acessoAtivo: liberado,
      compradoEm: usuario.acessoCompradoEmClaim || null,
      claimsAtualizadas: false
    };
  }

  // Migração automática das contas antigas: faz UMA leitura pequena em
  // LojaDayZombi/Usuarios/<uid>/AcessoTeste e grava o resultado no Auth.
  const status = await obterStatusAcessoTeste(usuario.uid);
  await atualizarClaimsAcessoTeste(usuario.uid, status);

  return {
    ...status,
    claimsAtualizadas: true
  };
}

async function atualizarClaimsAcessoTeste(uid, status) {
  if (!firebaseAuth || !uid) return;

  const registroAuth = await firebaseAuth.getUser(uid);
  const claimsAtuais = registroAuth.customClaims || {};
  const agora = Date.now();

  await firebaseAuth.setCustomUserClaims(uid, {
    ...claimsAtuais,
    [CLAIM_ACESSO_TESTE]: status?.temAcessoTeste === true,
    [CLAIM_ACESSO_SINCRONIZADO_EM]: agora,
    [CLAIM_ACESSO_COMPRADO_EM]: Number(status?.compradoEm) || 0
  });
}

async function obterStatusAcessoTeste(uid) {
  if (!firebaseDb || !uid) {
    return {
      temAcessoTeste: false,
      possuiChave: false,
      acessoAtivo: false,
      compradoEm: null
    };
  }

  const snapshot = await firebaseDb
    .ref(`${FIREBASE_LOJA_PATH}/Usuarios/${uid}/AcessoTeste`)
    .once("value");

  const acesso = snapshot.val() || {};
  const possuiChave =
    typeof acesso.chave === "string" && acesso.chave.trim().length > 10;
  const acessoAtivo = acesso.ativo === true;
  const temAcessoTeste = Boolean(
    acesso.comprado === true &&
    acessoAtivo &&
    possuiChave
  );

  return {
    temAcessoTeste,
    possuiChave,
    acessoAtivo,
    compradoEm: Number(acesso.compradoEm) || null
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

function normalizarIdDispositivo(valor) {
  const id = String(valor || "").trim();
  if (!id || id.length < 3 || id.length > 256) return "";
  return id;
}

function criarTokenSessaoApp({ uid, nick, foto, idDispositivo }) {
  if (!LOGIN_SESSION_DISPONIVEL) return null;

  const agora = Date.now();
  const payload = {
    v: 1,
    uid: String(uid || "").trim(),
    nick: limparNickPublico(nick || ""),
    foto: normalizarUrlExterna(foto || ""),
    dispositivoHash: criarHash(idDispositivo),
    emitidoEm: agora,
    expiraEm: agora + LOGIN_SESSION_TTL_MS
  };

  const payloadBase64 = Buffer
    .from(JSON.stringify(payload), "utf8")
    .toString("base64url");

  const assinatura = crypto
    .createHmac("sha256", LOGIN_SESSION_SECRET)
    .update(payloadBase64)
    .digest("base64url");

  return {
    token: `${payloadBase64}.${assinatura}`,
    expiraEm: payload.expiraEm
  };
}

function validarTokenSessaoApp(token, idDispositivo) {
  if (!LOGIN_SESSION_DISPONIVEL) {
    const error = new Error(
      "Login automático indisponível. Configure LOGIN_SESSION_SECRET no servidor."
    );
    error.statusCode = 503;
    throw error;
  }

  const tokenTexto = String(token || "").trim();
  const partes = tokenTexto.split(".");
  if (partes.length !== 2) {
    const error = new Error("Sessão salva inválida.");
    error.statusCode = 401;
    throw error;
  }

  const [payloadBase64, assinaturaRecebida] = partes;
  const assinaturaEsperada = crypto
    .createHmac("sha256", LOGIN_SESSION_SECRET)
    .update(payloadBase64)
    .digest("base64url");

  const recebida = Buffer.from(assinaturaRecebida);
  const esperada = Buffer.from(assinaturaEsperada);

  if (
    recebida.length !== esperada.length ||
    !crypto.timingSafeEqual(recebida, esperada)
  ) {
    const error = new Error("Sessão salva inválida.");
    error.statusCode = 401;
    throw error;
  }

  let payload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadBase64, "base64url").toString("utf8")
    );
  } catch {
    const error = new Error("Sessão salva inválida.");
    error.statusCode = 401;
    throw error;
  }

  if (
    payload?.v !== 1 ||
    !payload.uid ||
    !payload.nick ||
    Number(payload.expiraEm) <= Date.now()
  ) {
    const error = new Error("A sessão salva expirou. Faça login novamente.");
    error.statusCode = 401;
    throw error;
  }

  const dispositivoHash = criarHash(idDispositivo);
  if (payload.dispositivoHash !== dispositivoHash) {
    const error = new Error(
      "Esta sessão pertence a outro dispositivo. Faça login novamente."
    );
    error.statusCode = 401;
    throw error;
  }

  return {
    uid: String(payload.uid),
    nick: limparNickPublico(payload.nick),
    foto: normalizarUrlExterna(payload.foto || ""),
    expiraEm: Number(payload.expiraEm) || 0
  };
}


function carregarProdutosTitulosDoAmbiente() {
  const bruto =
    String(process.env.TITULOS_PRODUTOS_JSON || "").trim();

  if (!bruto) {
    return Object.freeze({});
  }

  try {
    const objeto = JSON.parse(bruto);
    const resultado = {};

    for (const [idBruto, valorBruto] of
         Object.entries(objeto || {})) {
      const productId =
        normalizarProductIdGoogle(idBruto);

      const quantidade = Number(
        valorBruto &&
        typeof valorBruto === "object"
          ? valorBruto.quantidade
          : valorBruto
      );

      if (
        productId &&
        Number.isSafeInteger(quantidade) &&
        quantidade > 0 &&
        quantidade <= 10000000
      ) {
        resultado[productId] = quantidade;
      }
    }

    return Object.freeze(resultado);
  } catch (error) {
    console.error(
      "[Compras] TITULOS_PRODUTOS_JSON inválido:",
      error?.message || error
    );

    return Object.freeze({});
  }
}


function obterQuantidadeTitulosProduto(productId) {
  const id = normalizarProductIdGoogle(productId);
  if (!id) return 0;

  const configurada = Number(TITULOS_PRODUTOS[id]);
  if (
    Number.isSafeInteger(configurada) &&
    configurada > 0
  ) {
    return configurada;
  }

  // Padrão atual do projeto:
  // pacote_100_titulos -> 100
  let match =
    /^pacote_(\d+)_titulos$/i.exec(id);

  if (match) {
    const quantidade = Number(match[1]);
    return Number.isSafeInteger(quantidade) &&
           quantidade > 0
      ? quantidade
      : 0;
  }

  // Pacotes com bônus:
  // pacote_1000_bonus_100 -> 1100
  match =
    /^pacote_(\d+)_bonus_(\d+)$/i.exec(id);

  if (match) {
    const base = Number(match[1]);
    const bonus = Number(match[2]);
    const total = base + bonus;

    return Number.isSafeInteger(total) &&
           base > 0 &&
           bonus >= 0
      ? total
      : 0;
  }

  // Compatibilidade com IDs antigos como titulos_100.
  match = /^titulos_(\d+)$/i.exec(id);

  if (match) {
    const quantidade = Number(match[1]);
    return Number.isSafeInteger(quantidade) &&
           quantidade > 0
      ? quantidade
      : 0;
  }

  return 0;
}


function normalizarProductIdGoogle(valor) {
  const texto = String(valor || "").trim();

  return /^[A-Za-z0-9._-]{1,200}$/.test(texto)
    ? texto
    : "";
}


function parseJsonSeguro(valor) {
  if (valor &&
      typeof valor === "object") {
    return valor;
  }

  const texto = String(valor || "").trim();
  if (!texto) return null;

  try {
    return JSON.parse(texto);
  } catch {
    return null;
  }
}


function extrairCompraGoogleDoRecibo(receipt) {
  const recibo = parseJsonSeguro(receipt);

  if (!recibo ||
      typeof recibo !== "object") {
    const error = new Error(
      "O recibo enviado pelo Unity não é um JSON válido."
    );
    error.statusCode = 400;
    throw error;
  }

  const store =
    String(recibo.Store || recibo.store || "").trim();

  if (store &&
      !/google\s*play/i.test(store)) {
    const error = new Error(
      "Esta rota aceita somente compras da Google Play."
    );
    error.statusCode = 400;
    throw error;
  }

  const payload =
    recibo.Payload ?? recibo.payload ?? null;

  const payloadObjeto =
    parseJsonSeguro(payload);

  let compra = null;

  if (payloadObjeto &&
      typeof payloadObjeto === "object") {
    if (typeof payloadObjeto.json === "string") {
      compra =
        parseJsonSeguro(payloadObjeto.json);
    } else if (
      typeof payloadObjeto.purchaseData === "string"
    ) {
      compra =
        parseJsonSeguro(payloadObjeto.purchaseData);
    } else if (
      payloadObjeto.purchaseToken ||
      payloadObjeto.token
    ) {
      compra = payloadObjeto;
    }
  }

  if (!compra &&
      typeof payload === "string") {
    const direto =
      parseJsonSeguro(payload);

    if (direto?.purchaseToken ||
        direto?.token) {
      compra = direto;
    }
  }

  if (!compra &&
      (recibo.purchaseToken ||
       recibo.token)) {
    compra = recibo;
  }

  if (!compra ||
      typeof compra !== "object") {
    const error = new Error(
      "Não foi possível localizar os dados da compra Google dentro do recibo."
    );
    error.statusCode = 400;
    throw error;
  }

  const purchaseToken =
    String(
      compra.purchaseToken ||
      compra.token ||
      ""
    ).trim();

  if (!purchaseToken ||
      purchaseToken.length > 4096) {
    const error = new Error(
      "O recibo não contém um purchaseToken válido."
    );
    error.statusCode = 400;
    throw error;
  }

  return {
    purchaseToken,
    packageName:
      String(compra.packageName || "").trim(),
    productId:
      normalizarProductIdGoogle(
        compra.productId
      ),
    orderId:
      String(
        compra.orderId ||
        recibo.TransactionID ||
        recibo.transactionId ||
        ""
      ).trim(),
    purchaseTimeMillis:
      Number(compra.purchaseTimeMillis) ||
      Number(compra.purchaseTime) ||
      0
  };
}


function obterContaServicoGooglePlay(
  lancarErro = true
) {
  const jsonBruto = String(
    process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON ||
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    ""
  ).trim();

  if (jsonBruto) {
    try {
      let conteudo = jsonBruto;

      if (!conteudo.startsWith("{")) {
        conteudo =
          Buffer.from(
            conteudo,
            "base64"
          ).toString("utf8");
      }

      const conta = JSON.parse(conteudo);

      const clientEmail =
        String(
          conta.client_email || ""
        ).trim();

      const privateKey =
        String(
          conta.private_key || ""
        )
          .replace(/\\n/g, "\n")
          .trim();

      if (clientEmail && privateKey) {
        return {
          clientEmail,
          privateKey
        };
      }
    } catch (error) {
      if (lancarErro) {
        const e = new Error(
          "A credencial da conta de serviço usada pela Google Play está inválida."
        );
        e.statusCode = 503;
        throw e;
      }

      return null;
    }
  }

  const clientEmail = String(
    process.env.GOOGLE_PLAY_CLIENT_EMAIL ||
    process.env.FIREBASE_CLIENT_EMAIL ||
    ""
  ).trim();

  const privateKey = String(
    process.env.GOOGLE_PLAY_PRIVATE_KEY ||
    process.env.FIREBASE_PRIVATE_KEY ||
    ""
  )
    .replace(/\\n/g, "\n")
    .trim();

  if (clientEmail && privateKey) {
    return {
      clientEmail,
      privateKey
    };
  }

  if (lancarErro) {
    const error = new Error(
      "Credencial da conta de serviço não configurada no Render."
    );
    error.statusCode = 503;
    throw error;
  }

  return null;
}


async function obterAccessTokenGooglePlay() {
  const agora = Date.now();

  if (
    googlePlayAccessTokenCache.token &&
    googlePlayAccessTokenCache.expiraEm >
      agora + 60000
  ) {
    return googlePlayAccessTokenCache.token;
  }

  const conta =
    obterContaServicoGooglePlay(true);

  const agoraSegundos =
    Math.floor(agora / 1000);

  const cabecalho = Buffer.from(
    JSON.stringify({
      alg: "RS256",
      typ: "JWT"
    }),
    "utf8"
  ).toString("base64url");

  const payload = Buffer.from(
    JSON.stringify({
      iss: conta.clientEmail,
      scope: GOOGLE_PLAY_OAUTH_SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat: agoraSegundos,
      exp: agoraSegundos + 3600
    }),
    "utf8"
  ).toString("base64url");

  const semAssinatura =
    `${cabecalho}.${payload}`;

  const assinador =
    crypto.createSign("RSA-SHA256");

  assinador.update(semAssinatura);
  assinador.end();

  const assinatura =
    assinador
      .sign(conta.privateKey)
      .toString("base64url");

  const assertion =
    `${semAssinatura}.${assinatura}`;

  const corpo =
    new URLSearchParams({
      grant_type:
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    }).toString();

  const resposta =
    await requisicaoHttps(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
          "Content-Length":
            Buffer.byteLength(corpo)
        },
        body: corpo,
        timeoutMs: 20000
      }
    );

  const json =
    parseJsonSeguro(resposta.texto) || {};

  if (
    resposta.statusCode < 200 ||
    resposta.statusCode >= 300 ||
    !json.access_token
  ) {
    const error = new Error(
      "Não foi possível autenticar o servidor na Google Play Developer API."
    );
    error.statusCode = 503;
    throw error;
  }

  const expiresIn =
    Math.max(
      300,
      Number(json.expires_in) || 3600
    );

  googlePlayAccessTokenCache = {
    token:
      String(json.access_token),
    expiraEm:
      Date.now() +
      Math.max(
        60,
        expiresIn - 120
      ) * 1000
  };

  return googlePlayAccessTokenCache.token;
}


async function validarCompraNoGooglePlay(
  productId,
  purchaseToken
) {
  for (
    let tentativa = 0;
    tentativa < 2;
    tentativa++
  ) {
    const accessToken =
      await obterAccessTokenGooglePlay();

    const url =
      "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/" +
      `${encodeURIComponent(APP_PACKAGE)}/purchases/products/` +
      `${encodeURIComponent(productId)}/tokens/` +
      encodeURIComponent(purchaseToken);

    const resposta =
      await requisicaoHttps(
        url,
        {
          method: "GET",
          headers: {
            Authorization:
              `Bearer ${accessToken}`,
            Accept: "application/json"
          },
          timeoutMs: 20000
        }
      );

    if (
      resposta.statusCode === 401 &&
      tentativa === 0
    ) {
      googlePlayAccessTokenCache = {
        token: "",
        expiraEm: 0
      };

      continue;
    }

    if (resposta.statusCode === 403) {
      const error = new Error(
        "A conta de serviço do Render ainda não possui permissão na Google Play Console."
      );
      error.statusCode = 503;
      throw error;
    }

    if (
      resposta.statusCode === 404 ||
      resposta.statusCode === 400
    ) {
      const error = new Error(
        "A Google Play não reconheceu esta compra."
      );
      error.statusCode = 400;
      throw error;
    }

    if (
      resposta.statusCode < 200 ||
      resposta.statusCode >= 300
    ) {
      const error = new Error(
        "A Google Play não pôde validar a compra agora. HTTP " +
        resposta.statusCode
      );
      error.statusCode = 502;
      throw error;
    }

    return (
      parseJsonSeguro(resposta.texto) ||
      {}
    );
  }

  const error = new Error(
    "Não foi possível autenticar a consulta na Google Play."
  );
  error.statusCode = 503;
  throw error;
}


async function reservarCompraGoogleTitulos({
  purchaseTokenHash,
  uid,
  productId,
  quantidadeTitulos,
  orderId,
  purchaseTimeMillis
}) {
  const ref = firebaseDb.ref(
    `COMPRAS_GOOGLE_TITULOS/${purchaseTokenHash}`
  );

  let conflito = false;
  const agora = Date.now();

  const transacao =
    await ref.transaction(
      (atual) => {
        if (
          atual &&
          typeof atual === "object"
        ) {
          if (
            String(atual.uid || "") !== uid ||
            String(atual.productId || "") !==
              productId
          ) {
            conflito = true;
            return;
          }

          return atual;
        }

        return {
          uid,
          productId,
          quantidadeTitulos,
          orderId:
            orderId || null,
          purchaseTimeMillis:
            Number(purchaseTimeMillis) || null,
          status: "reservada",
          reservadoEm: agora
        };
      },
      undefined,
      false
    );

  if (!transacao.committed) {
    if (conflito) {
      const error = new Error(
        "Esta compra já foi vinculada a outra conta ou produto."
      );
      error.statusCode = 409;
      throw error;
    }

    const atual =
      (await ref.once("value")).val();

    if (
      !atual ||
      String(atual.uid || "") !== uid ||
      String(atual.productId || "") !==
        productId
    ) {
      const error = new Error(
        "Não foi possível reservar esta compra."
      );
      error.statusCode = 409;
      throw error;
    }

    return {
      ref,
      registro: atual
    };
  }

  const registro =
    transacao.snapshot.val() || {};

  if (
    String(registro.uid || "") !== uid ||
    String(registro.productId || "") !==
      productId
  ) {
    const error = new Error(
      "Esta compra já foi vinculada a outra conta ou produto."
    );
    error.statusCode = 409;
    throw error;
  }

  return {
    ref,
    registro
  };
}


async function creditarTitulosGoogleIdempotente({
  uid,
  purchaseTokenHash,
  productId,
  quantidadeTitulos,
  orderId
}) {
  const dadosRef =
    firebaseDb.ref(
      `${FIREBASE_LOGINS_PATH}/USUARIOS/${uid}/Dados`
    );

  const idDestaExecucao =
    crypto.randomUUID();

  let erroTransacao = "";

  const transacao =
    await dadosRef.transaction(
      (atual) => {
        const dados =
          atual &&
          typeof atual === "object" &&
          !Array.isArray(atual)
            ? { ...atual }
            : {};

        const compras =
          dados._comprasGoogleTitulos &&
          typeof dados._comprasGoogleTitulos ===
            "object" &&
          !Array.isArray(
            dados._comprasGoogleTitulos
          )
            ? {
                ...dados._comprasGoogleTitulos
              }
            : {};

        if (compras[purchaseTokenHash]) {
          return dados;
        }

        let saldoAtualBruto =
          Number(dados.Titulos);

        // Migração segura de conta antiga:
        // se Titulos ainda não existir, aproveita Dolls.
        if (!Number.isFinite(saldoAtualBruto)) {
          saldoAtualBruto =
            Number(dados.Dolls);
        }

        const saldoAtual =
          Number.isFinite(saldoAtualBruto)
            ? Math.max(
                0,
                Math.trunc(saldoAtualBruto)
              )
            : 0;

        const novoSaldo =
          saldoAtual + quantidadeTitulos;

        if (
          !Number.isSafeInteger(novoSaldo) ||
          novoSaldo < 0
        ) {
          erroTransacao =
            "O saldo de Títulos ultrapassaria o limite seguro.";
          return;
        }

        dados.Titulos = novoSaldo;

        compras[purchaseTokenHash] = {
          productId,
          quantidadeTitulos,
          orderId:
            orderId || null,
          processadoEm: Date.now(),
          execucao:
            idDestaExecucao
        };

        dados._comprasGoogleTitulos =
          compras;

        return dados;
      },
      undefined,
      false
    );

  if (!transacao.committed) {
    const error = new Error(
      erroTransacao ||
      "Não foi possível creditar os Títulos agora."
    );
    error.statusCode = 500;
    throw error;
  }

  const final =
    transacao.snapshot.val() || {};

  const registro =
    final?._comprasGoogleTitulos?.[
      purchaseTokenHash
    ] || {};

  const novoSaldo =
    Math.max(
      0,
      Math.trunc(
        Number(final.Titulos) || 0
      )
    );

  return {
    jaProcessada:
      registro.execucao !==
      idDestaExecucao,
    novoSaldo
  };
}


function requisicaoHttps(
  urlTexto,
  {
    method = "GET",
    headers = {},
    body = null,
    timeoutMs = 20000
  } = {}
) {
  return new Promise((resolve, reject) => {
    let url;

    try {
      url = new URL(urlTexto);
    } catch {
      const error = new Error(
        "URL HTTPS inválida."
      );
      error.statusCode = 500;
      reject(error);
      return;
    }

    const req =
      https.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port:
            url.port || undefined,
          path:
            `${url.pathname}${url.search}`,
          method,
          headers
        },
        (res) => {
          let texto = "";

          res.setEncoding("utf8");

          res.on(
            "data",
            (chunk) => {
              texto += chunk;

              if (texto.length > 1024 * 1024) {
                req.destroy(
                  new Error(
                    "Resposta HTTPS excedeu o limite."
                  )
                );
              }
            }
          );

          res.on("end", () => {
            resolve({
              statusCode:
                Number(res.statusCode) || 0,
              headers:
                res.headers || {},
              texto
            });
          });
        }
      );

    req.setTimeout(
      timeoutMs,
      () => {
        req.destroy(
          new Error(
            "Tempo limite ao consultar serviço externo."
          )
        );
      }
    );

    req.on(
      "error",
      (error) => {
        reject(error);
      }
    );

    if (body) {
      req.write(body);
    }

    req.end();
  });
}


function contaPublicaLogin(dados) {
  const dadosSeguros = clonarObjeto(dados);
  return {
    nick: dadosSeguros.nick || null,
    criadoEm: Number(dadosSeguros.criadoEm) || null,
    ultimoLoginEm: Number(dadosSeguros.ultimoLoginEm) || null
  };
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
