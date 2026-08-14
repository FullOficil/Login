require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const {
  MercadoPagoConfig,
  Payment,
  WebhookSignatureValidator,
  InvalidWebhookSignatureError
} = require("mercadopago");
const {
  initializeApp: initializeFirebaseApp,
  applicationDefault,
  cert
} = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getDatabase } = require("firebase-admin/database");

const app = express();
app.disable("x-powered-by");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = normalizarUrlPublica(process.env.PUBLIC_URL || "");
const MP_ACCESS_TOKEN = String(process.env.MP_ACCESS_TOKEN || "").trim();
const MP_PUBLIC_KEY = String(process.env.MP_PUBLIC_KEY || "").trim();
const MP_WEBHOOK_SECRET = String(process.env.MP_WEBHOOK_SECRET || "").trim();
const GAME_DOWNLOAD_URL = normalizarUrlExterna(process.env.GAME_DOWNLOAD_URL || "");
const TELEGRAM_URL = normalizarUrlExterna(
  process.env.TELEGRAM_URL || "https://t.me/+CyDPE-Hbq00wOGRh"
);

// Mantém compatibilidade com o Render que já está configurado hoje.
// As opções FIREBASE_WEB_* continuam aceitas, mas NÃO são obrigatórias.
const FIREBASE_DATABASE_URL = String(
  process.env.FIREBASE_DATABASE_URL ||
  "https://dayzozmbi-server-default-rtdb.firebaseio.com"
).trim();
const FIREBASE_WEB_CONFIG = Object.freeze({
  apiKey: String(
    process.env.FIREBASE_WEB_API_KEY ||
    "AIzaSyB5A-ySceXCFRQ7iSCnOA68nRJqYpK6DQc"
  ).trim(),
  authDomain: String(
    process.env.FIREBASE_AUTH_DOMAIN ||
    "dayzozmbi-server.firebaseapp.com"
  ).trim(),
  projectId: String(
    process.env.FIREBASE_WEB_PROJECT_ID ||
    "dayzozmbi-server"
  ).trim(),
  databaseURL: FIREBASE_DATABASE_URL,
  storageBucket: String(
    process.env.FIREBASE_STORAGE_BUCKET ||
    "dayzozmbi-server.firebasestorage.app"
  ).trim(),
  messagingSenderId: String(
    process.env.FIREBASE_MESSAGING_SENDER_ID ||
    "221905253103"
  ).trim()
});

const FIREBASE_LOGINS_PATH = "LOGINS_REGISTRADOS";
const FIREBASE_STORE_PATH = "LojaDayZombiOficial";
const FIREBASE_PROMOS_PATH = `${FIREBASE_STORE_PATH}/Promocoes`;
const FIREBASE_PROMO_LEGACY_PATH = `${FIREBASE_STORE_PATH}/PromocaoAtual`;
const FIREBASE_KEY_SALE_PATH = `${FIREBASE_STORE_PATH}/VendaChave`;

// Mantém exatamente o mesmo armazenamento de chaves da loja antiga,
// para não quebrar chaves já compradas nem o endpoint usado pelo jogo.
const FIREBASE_ACCESS_STORE_PATH = "LojaDayZombi";
const FIREBASE_KEYS_PATH = "Chaves de Acessos";
const KEY_PRODUCT_ID = "chave-acesso";
const LIMITE_HISTORICO = 40;

// ============================================================
// CATÁLOGO
// Edite aqui preços/quantidades. O navegador NÃO decide preços.
// ============================================================
const PRODUTOS = Object.freeze({
  "titulos-100": Object.freeze({
    id: "titulos-100",
    titulo: "100 Títulos",
    descricao: "Pacote com 100 Títulos para sua conta Day Zombi Survival.",
    categoria: "titulos",
    valor: 9.99,
    moeda: "BRL",
    titulos: 100,
    destaque: false,
    badge: ""
  }),
  "titulos-500": Object.freeze({
    id: "titulos-500",
    titulo: "500 Títulos",
    descricao: "Pacote com 500 Títulos para sua conta Day Zombi Survival.",
    categoria: "titulos",
    valor: 49.99,
    moeda: "BRL",
    titulos: 500,
    destaque: false,
    badge: ""
  }),
  "titulos-1000": Object.freeze({
    id: "titulos-1000",
    titulo: "1.000 Títulos",
    descricao: "Pacote com 1.000 Títulos para sua conta Day Zombi Survival.",
    categoria: "titulos",
    valor: 99.99,
    moeda: "BRL",
    titulos: 1000,
    destaque: true,
    badge: "Popular"
  }),
  "titulos-2000": Object.freeze({
    id: "titulos-2000",
    titulo: "2.000 Títulos",
    descricao: "Pacote com 2.000 Títulos para sua conta Day Zombi Survival.",
    categoria: "titulos",
    valor: 199.99,
    moeda: "BRL",
    titulos: 2000,
    destaque: false,
    badge: ""
  }),
  "titulos-3000": Object.freeze({
    id: "titulos-3000",
    titulo: "3.000 Títulos",
    descricao: "Pacote com 3.000 Títulos para sua conta Day Zombi Survival.",
    categoria: "titulos",
    valor: 299.99,
    moeda: "BRL",
    titulos: 3000,
    destaque: false,
    badge: ""
  }),
  "titulos-4000": Object.freeze({
    id: "titulos-4000",
    titulo: "4.000 Títulos",
    descricao: "Pacote com 4.000 Títulos para sua conta Day Zombi Survival.",
    categoria: "titulos",
    valor: 399.99,
    moeda: "BRL",
    titulos: 4000,
    destaque: false,
    badge: ""
  }),
  "titulos-5000": Object.freeze({
    id: "titulos-5000",
    titulo: "5.000 Títulos",
    descricao: "Pacote com 5.000 Títulos para sua conta Day Zombi Survival.",
    categoria: "titulos",
    valor: 499.99,
    moeda: "BRL",
    titulos: 5000,
    destaque: false,
    badge: ""
  })
});

const tokenConfigurado = MP_ACCESS_TOKEN.length > 20 && !MP_ACCESS_TOKEN.includes("COLE_AQUI");
const publicKeyConfigurada = MP_PUBLIC_KEY.length > 20 && !MP_PUBLIC_KEY.includes("COLE_AQUI");
const webhookConfigurado = MP_WEBHOOK_SECRET.length >= 16 && !MP_WEBHOOK_SECRET.includes("COLE_AQUI");
const firebaseWebConfigurado = Boolean(
  FIREBASE_WEB_CONFIG.apiKey &&
  FIREBASE_WEB_CONFIG.authDomain &&
  FIREBASE_WEB_CONFIG.projectId &&
  FIREBASE_WEB_CONFIG.databaseURL
);

let paymentClient = null;
let firebaseDb = null;
let firebaseAuth = null;
let firebaseErroInicializacao = null;

if (tokenConfigurado) {
  const mpClient = new MercadoPagoConfig({
    accessToken: MP_ACCESS_TOKEN,
    options: { timeout: 12000 }
  });
  paymentClient = new Payment(mpClient);
}

try {
  const credential = carregarCredencialFirebase();
  if (credential && FIREBASE_DATABASE_URL) {
    const firebaseApp = initializeFirebaseApp({
      credential,
      databaseURL: FIREBASE_DATABASE_URL
    });
    firebaseDb = getDatabase(firebaseApp);
    firebaseAuth = getAuth(firebaseApp);
  }
} catch (error) {
  firebaseErroInicializacao = error;
  console.error("Firebase Admin não inicializado:", resumirErro(error));
}

app.use(express.json({ limit: "220kb" }));
app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: "5m"
}));

app.get("/api/saude", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    online: true,
    pagamentos: Boolean(paymentClient && publicKeyConfigurada),
    autenticacao: Boolean(firebaseWebConfigurado),
    dadosConta: Boolean(firebaseDb && firebaseAuth),
    lojaConfigurada: Boolean(PUBLIC_URL)
  });
});

app.get("/api/configuracao-publica", async (_req, res) => {
  res.set("Cache-Control", "no-store");

  const [produtos, vendaChave] = await Promise.all([
    obterCatalogoPublico(),
    obterVendaChavePublica()
  ]);

  res.json({
    publicKey: publicKeyConfigurada ? MP_PUBLIC_KEY : null,
    firebaseWebConfig: firebaseWebConfigurado ? FIREBASE_WEB_CONFIG : null,
    // Login Google é feito pelo SDK Web no navegador; não depende do Admin.
    autenticacaoDisponivel: Boolean(firebaseWebConfigurado),
    checkoutDisponivel: Boolean(paymentClient && publicKeyConfigurada),
    produtos,
    vendaChave
  });
});

// A página consulta esta rota periodicamente. Promoções de Títulos e a venda
// opcional de chave aparecem/desaparecem sem precisar de novo deploy.
app.get("/api/produtos", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const [produtos, vendaChave] = await Promise.all([
    obterCatalogoPublico(),
    obterVendaChavePublica()
  ]);
  return res.json({ produtos, vendaChave });
});

app.get("/api/minha-conta", async (req, res) => {
  res.set("Cache-Control", "no-store");

  // Não confunda servidor sem acesso ao banco com uma conta sem Nick.
  if (!firebaseDb || !firebaseAuth) {
    return res.status(503).json({
      autenticado: false,
      cadastrado: false,
      erro: "Serviço de conta temporariamente indisponível."
    });
  }

  try {
    const usuario = await obterUsuarioAutenticado(req, true);

    // Mesmo caminho usado pelo projeto Login-main:
    // LOGINS_REGISTRADOS/USUARIOS/<firebaseUid>
    const conta = await obterContaPorUid(usuario.uid);

    return res.json({
      autenticado: true,
      cadastrado: Boolean(conta?.Dados?.nick),
      usuario: usuarioPublico(usuario),
      conta: contaPublica(conta)
    });
  } catch (error) {
    return responderErroAutenticacao(res, error);
  }
});

app.post("/api/cadastrar-conta", async (req, res) => {
  res.set("Cache-Control", "no-store");

  if (!firebaseDb) {
    return res.status(503).json({ erro: "Serviço de conta temporariamente indisponível." });
  }

  try {
    const usuario = await obterUsuarioAutenticado(req, true);
    const contaExistente = await obterContaPorUid(usuario.uid);

    // Se o Login principal já cadastrou esta conta, reutilize o Nick existente.
    if (contaExistente?.Dados?.nick) {
      return res.json({
        autenticado: true,
        cadastrado: true,
        usuario: usuarioPublico(usuario),
        conta: contaPublica(contaExistente)
      });
    }

    // O Login-main usa o próprio Firebase UID como chave de USUARIOS.
    const uidConta = usuario.uid;
    const nickInfo = normalizarNickConta(req.body?.nick);

    if (!nickInfo) {
      return res.status(400).json({
        erro: "Use de 3 a 20 caracteres: letras, números, _ ou -."
      });
    }

    const loginsRef = firebaseDb.ref(FIREBASE_LOGINS_PATH);
    let nickEmUso = false;

    const transacao = await loginsRef.transaction((estadoAtual) => {
      const estado = estadoAtual && typeof estadoAtual === "object"
        ? { ...estadoAtual }
        : {};
      const usuarios = clonarObjeto(estado.USUARIOS);
      const nicks = clonarObjeto(estado.NICKS);
      const uidParaNick = clonarObjeto(estado.UID_PARA_NICK);
      const contaAtual = clonarObjeto(usuarios[uidConta]);
      const dadosAtuais = clonarObjeto(contaAtual.Dados);

      if (dadosAtuais.nick) return estado;

      const dono = nicks[nickInfo.nickKey]?.uid;
      if (dono && dono !== uidConta) {
        nickEmUso = true;
        return;
      }

      const agora = Date.now();
      usuarios[uidConta] = {
        ...contaAtual,
        Dados: {
          ...dadosAtuais,
          firebaseUid: usuario.uid,
          googleEmail: usuario.email || "",
          googleNome: usuario.nome || "",
          googleFoto: usuario.foto || "",
          provedor: usuario.provedor || "google.com",
          emailVerificado: Boolean(usuario.emailVerificado),
          nick: nickInfo.nick,
          nickChave: nickInfo.nickKey,
          Titulos: obterSaldoTitulosConta(contaAtual),
          criadoEm: dadosAtuais.criadoEm || agora,
          ultimoLoginEm: agora,
          atualizadoEm: agora
        }
      };

      nicks[nickInfo.nickKey] = {
        uid: uidConta,
        nick: nickInfo.nick,
        criadoEm: nicks[nickInfo.nickKey]?.criadoEm || agora
      };
      uidParaNick[uidConta] = {
        nickChave: nickInfo.nickKey,
        nick: nickInfo.nick
      };

      estado.USUARIOS = usuarios;
      estado.NICKS = nicks;
      estado.UID_PARA_NICK = uidParaNick;
      return estado;
    }, undefined, false);

    if (!transacao.committed) {
      if (nickEmUso) {
        return res.status(409).json({ erro: "Esse Nick já está em uso." });
      }
      return res.status(500).json({ erro: "Não foi possível cadastrar a conta." });
    }

    const conta = transacao.snapshot.child(`USUARIOS/${uidConta}`).val();
    return res.status(201).json({
      autenticado: true,
      cadastrado: true,
      usuario: usuarioPublico(usuario),
      conta: contaPublica(conta)
    });
  } catch (error) {
    return responderErroAutenticacao(res, error);
  }
});

app.get("/api/minha-carteira", async (req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    const usuario = await obterUsuarioAutenticado(req, true);
    const conta = await obterContaPorUid(usuario.uid);
    if (!conta?.Dados?.nick) {
      return res.status(403).json({ erro: "Escolha seu Nick primeiro." });
    }

    const pagamentos = clonarObjeto(conta?.Eventos?.PagamentosLoja);
    const historico = Object.values(pagamentos)
      .sort((a, b) => Number(b.atualizadoEm || 0) - Number(a.atualizadoEm || 0))
      .slice(0, LIMITE_HISTORICO)
      .map((item) => ({
        pagamentoId: item.pagamentoId || "",
        produtoId: item.produtoId || "",
        produtoTitulo: item.produtoTitulo || "",
        categoria: item.categoria || (item.vendaChave ? "chave" : "titulos"),
        vendaChave: Boolean(item.vendaChave),
        valor: Number(item.valor) || 0,
        moeda: item.moeda || "BRL",
        titulos: Number(item.titulos) || 0,
        status: item.status || "",
        contabilizar: Boolean(item.contabilizar),
        aprovadoEm: Number(item.aprovadoEm) || null,
        atualizadoEm: Number(item.atualizadoEm) || null
      }));

    const acesso = await obterAcessoChavePorUid(usuario.uid);

    return res.json({
      nick: conta.Dados.nick,
      saldoTitulos: obterSaldoTitulosConta(conta),
      historico,
      promocoesAdquiridas: obterIdsPromocoesAdquiridas(conta),
      acessoComprado: Boolean(acesso?.comprado && acesso?.ativo && acesso?.chave)
    });
  } catch (error) {
    return responderErroAutenticacao(res, error);
  }
});

app.get("/api/meu-acesso", async (req, res) => {
  res.set("Cache-Control", "no-store");

  if (!firebaseDb) {
    return res.status(503).json({ erro: "Servidor de chaves indisponível." });
  }

  try {
    const usuario = await obterUsuarioAutenticado(req, true);
    const acesso = await obterAcessoChavePorUid(usuario.uid);

    if (!acesso?.comprado || !acesso?.ativo || !acesso?.chave) {
      return res.json({
        autenticado: true,
        comprado: false,
        usuario: usuarioPublico(usuario)
      });
    }

    return res.json({
      autenticado: true,
      comprado: true,
      usuario: usuarioPublico(usuario),
      acesso: {
        chave: String(acesso.chave),
        aviso: "Uso único. Não compartilhe esta chave.",
        compradoEm: Number(acesso.compradoEm) || null,
        atualizadoEm: Number(acesso.atualizadoEm) || null,
        usada: Boolean(acesso.usada || acesso.usado),
        telegramUrl: TELEGRAM_URL || null,
        downloadUrl: GAME_DOWNLOAD_URL || null,
        downloadDisponivel: Boolean(GAME_DOWNLOAD_URL)
      }
    });
  } catch (error) {
    return responderErroAutenticacao(res, error);
  }
});

// Endpoint mantido compatível com o sistema de chave da loja antiga.
// Na primeira ativação, a chave fica vinculada ao identificador do jogador.
app.post("/api/ativar-chave", async (req, res) => {
  res.set("Cache-Control", "no-store");

  if (!firebaseDb) {
    return res.status(503).json({
      valida: false,
      erro: "Servidor de chaves indisponível."
    });
  }

  const chave = normalizarChaveAcesso(req.body?.chave);
  const identificadorJogador = normalizarIdentificadorJogador(
    req.body?.identificadorJogador
  );

  if (!chave || !identificadorJogador) {
    return res.status(400).json({
      valida: false,
      erro: "Informe uma chave e um identificador de jogador válidos."
    });
  }

  const chaveRef = firebaseDb.ref(
    `${FIREBASE_ACCESS_STORE_PATH}/${FIREBASE_KEYS_PATH}/${chave}`
  );
  let resultadoLocal = "invalida";

  try {
    const transacao = await chaveRef.transaction((registroAtual) => {
      if (!registroAtual || registroAtual.ativa !== true) {
        resultadoLocal = "invalida";
        return;
      }

      if (registroAtual.usada === true) {
        if (registroAtual.usadaPor === identificadorJogador) {
          resultadoLocal = "mesmo_jogador";
          return registroAtual;
        }

        resultadoLocal = "ja_usada";
        return;
      }

      resultadoLocal = "ativada";
      return {
        ...registroAtual,
        usada: true,
        usadaPor: identificadorJogador,
        usadaEm: Date.now(),
        atualizadoEm: Date.now()
      };
    }, undefined, false);

    if (!transacao.committed && resultadoLocal === "ja_usada") {
      return res.status(409).json({
        valida: false,
        jaUsada: true,
        erro: "Esta chave já foi ativada por outro jogador."
      });
    }

    if (!transacao.committed && resultadoLocal === "invalida") {
      return res.status(404).json({
        valida: false,
        erro: "Chave inválida ou desativada."
      });
    }

    const registroFinal = transacao.snapshot.val();
    if (registroFinal?.uid && ["ativada", "mesmo_jogador"].includes(resultadoLocal)) {
      await firebaseDb.ref(
        `${FIREBASE_ACCESS_STORE_PATH}/Usuarios/${registroFinal.uid}/AcessoTeste`
      ).update({
        usada: true,
        usado: true,
        usadaEm: registroFinal.usadaEm || Date.now(),
        atualizadoEm: Date.now()
      });
    }

    return res.json({
      valida: true,
      ativadaAgora: resultadoLocal === "ativada",
      mensagem: resultadoLocal === "ativada"
        ? "Chave ativada com sucesso."
        : "Esta chave já está vinculada a este jogador."
    });
  } catch (error) {
    console.error("Erro ao ativar chave:", resumirErro(error));
    return res.status(502).json({
      valida: false,
      erro: "Não foi possível validar a chave agora."
    });
  }
});

app.post("/api/processar-pagamento", async (req, res) => {
  res.set("Cache-Control", "no-store");

  if (!paymentClient) {
    return res.status(503).json({ erro: "Pagamento temporariamente indisponível." });
  }

  const produtoId = limparTexto(req.body?.produtoId, 80);
  let produto = PRODUTOS[produtoId] || null;

  // Promoções de Títulos e a venda de chave são configuradas no painel local.
  // O navegador envia somente o ID; o servidor sempre busca preço/dados reais.
  if (!produto && produtoId.startsWith("promocao-")) {
    try {
      produto = await obterPromocaoPorId(produtoId);
    } catch (error) {
      console.error("Erro consultando promoção:", resumirErro(error));
      return res.status(503).json({ erro: "Não foi possível confirmar a promoção agora." });
    }
  }

  if (!produto && produtoId === KEY_PRODUCT_ID) {
    try {
      produto = await obterVendaChaveAtiva();
    } catch (error) {
      console.error("Erro consultando venda de chave:", resumirErro(error));
      return res.status(503).json({ erro: "Não foi possível confirmar a venda de chave agora." });
    }
  }

  const formData = req.body?.formData || {};
  const paymentMethodId = limparTexto(formData.payment_method_id, 60).toLowerCase();
  const tokenCartao = limparTexto(formData.token, 350);
  const pagador = sanitizarPagador(formData.payer);

  if (!produto) {
    return res.status(400).json({ erro: "Produto inválido." });
  }

  let usuario;
  let conta;
  try {
    usuario = await obterUsuarioAutenticado(req, true);
    conta = await obterContaPorUid(usuario.uid);
  } catch (error) {
    return responderErroAutenticacao(res, error);
  }

  if (!conta?.Dados?.nick) {
    return res.status(403).json({ erro: "Escolha seu Nick antes de comprar." });
  }

  if (produto.promocao && promocaoJaAdquirida(conta, produto.id)) {
    return res.status(409).json({
      erro: "Pacote já adquirido. Cada promoção pode ser comprada apenas uma vez por conta.",
      codigo: "PROMOCAO_JA_ADQUIRIDA"
    });
  }

  if (produto.vendaChave) {
    const acessoExistente = await obterAcessoChavePorUid(usuario.uid);
    if (acessoExistente?.comprado && acessoExistente?.ativo && acessoExistente?.chave) {
      return res.status(409).json({
        erro: "Sua conta já possui uma chave de acesso.",
        codigo: "CHAVE_JA_ADQUIRIDA"
      });
    }
  }

  if (!paymentMethodId) {
    return res.status(400).json({ erro: "Meio de pagamento não informado." });
  }

  const pagamentoPix = paymentMethodId === "pix";
  if (!pagamentoPix && !tokenCartao) {
    return res.status(400).json({ erro: "Token do cartão ausente." });
  }

  if (!pagador.email) {
    return res.status(400).json({ erro: "Informe um e-mail válido." });
  }

  const pedidoId = `dzstore-${produto.id}-${crypto.randomUUID()}`;
  const idempotencyKey = extrairChaveIdempotencia(req.headers["x-idempotency-key"]) || crypto.randomUUID();

  const body = {
    transaction_amount: produto.valor,
    description: produto.descricao,
    payment_method_id: paymentMethodId,
    payer: pagador,
    external_reference: pedidoId,
    statement_descriptor: "DAYZOMBI",
    metadata: {
      produto_id: produto.id,
      pedido_id: pedidoId,
      // UID autenticado: usado para confirmar que o pagamento pertence ao usuário logado.
      firebase_uid: usuario.uid,
      // No Login-main, a chave de USUARIOS é o próprio Firebase UID.
      conta_uid: usuario.uid,
      firebase_email: usuario.email || "",
      firebase_nome: usuario.nome || "",
      nick_conta: conta.Dados.nick,
      categoria: produto.categoria || "titulos",
      titulos: produto.titulos || 0,
      origem: "loja_oficial",
      promocao: Boolean(produto.promocao),
      promocao_versao: produto.promocao ? String(produto.versao || "") : "",
      promocao_descricao: produto.promocao ? produto.descricao : "",
      promocao_valor: produto.promocao ? produto.valor : 0,
      promocao_titulos: produto.promocao ? produto.titulos : 0,
      venda_chave: Boolean(produto.vendaChave),
      chave_titulo: produto.vendaChave ? produto.titulo : "",
      chave_descricao: produto.vendaChave ? produto.descricao : "",
      chave_valor: produto.vendaChave ? produto.valor : 0,
      chave_promocional: produto.vendaChave ? Boolean(produto.promocional) : false,
      chave_expira_em: produto.vendaChave ? Number(produto.expiraEm) || 0 : 0
    }
  };

  if (!pagamentoPix) {
    body.token = tokenCartao;
    body.installments = Math.max(1, Math.min(12, Number(formData.installments) || 1));
    const issuerId = limparTexto(formData.issuer_id, 40);
    if (issuerId) body.issuer_id = issuerId;
  }

  if (PUBLIC_URL) {
    body.notification_url = `${PUBLIC_URL}/api/webhook`;
  }

  try {
    const pagamento = await paymentClient.create({
      body,
      requestOptions: { idempotencyKey }
    });

    let registro = null;
    if (["approved", "refunded", "charged_back"].includes(String(pagamento.status).toLowerCase())) {
      registro = await registrarPagamentoNoFirebase(pagamento, produto);
    }

    return res.status(201).json(resumirPagamento(pagamento, registro));
  } catch (error) {
    console.error("Erro ao criar pagamento:", resumirErro(error));
    return res.status(extrairStatusErro(error)).json({
      erro: mensagemAmigavelDoErro(error),
      detalhe: extrairDetalheSeguro(error)
    });
  }
});

app.get("/api/verificar-pagamento", async (req, res) => {
  res.set("Cache-Control", "no-store");

  if (!paymentClient) {
    return res.status(503).json({ aprovado: false, erro: "Pagamento temporariamente indisponível." });
  }

  const paymentId = extrairIdPagamento(req.query.payment_id);
  if (!paymentId) {
    return res.status(400).json({ aprovado: false, erro: "payment_id inválido." });
  }

  try {
    const usuario = await obterUsuarioAutenticado(req, true);
    const pagamento = await paymentClient.get({ id: paymentId });
    const uidPagamento = limparTexto(pagamento?.metadata?.firebase_uid, 160);

    if (!uidPagamento || uidPagamento !== usuario.uid) {
      return res.status(403).json({ aprovado: false, erro: "Esse pagamento não pertence à sua conta." });
    }

    const produto = obterProdutoDoPagamento(pagamento);
    let registro = null;

    if (produto && ["approved", "refunded", "charged_back"].includes(String(pagamento.status).toLowerCase())) {
      registro = await registrarPagamentoNoFirebase(pagamento, produto);
    }

    return res.json(resumirPagamento(pagamento, registro));
  } catch (error) {
    if (Number(error?.statusCode) === 401) return responderErroAutenticacao(res, error);
    console.error("Erro ao consultar pagamento:", resumirErro(error));
    return res.status(502).json({ aprovado: false, erro: "Não foi possível consultar o pagamento." });
  }
});

app.post("/api/webhook", async (req, res) => {
  if (!webhookConfigurado) {
    console.warn("Webhook ignorado: MP_WEBHOOK_SECRET não configurado.");
    return res.sendStatus(200);
  }

  const dataId = req.query["data.id"];

  try {
    WebhookSignatureValidator.validate({
      xSignature: req.headers["x-signature"],
      xRequestId: req.headers["x-request-id"],
      dataId,
      secret: MP_WEBHOOK_SECRET,
      toleranceSeconds: 300
    });
  } catch (error) {
    if (error instanceof InvalidWebhookSignatureError) {
      console.warn("Webhook rejeitado:", error.reason);
      return res.sendStatus(401);
    }
    console.error("Erro validando webhook:", error);
    return res.sendStatus(500);
  }

  const tipo = String(req.query.type || req.body?.type || "").toLowerCase();
  const paymentId = extrairIdPagamento(dataId || req.body?.data?.id);
  if (tipo && tipo !== "payment") return res.sendStatus(200);
  if (!paymentId || !paymentClient) return res.sendStatus(200);

  try {
    const pagamento = await paymentClient.get({ id: paymentId });
    const produto = obterProdutoDoPagamento(pagamento);
    if (produto) {
      await registrarPagamentoNoFirebase(pagamento, produto);
    }
    return res.sendStatus(200);
  } catch (error) {
    console.error("Falha no webhook:", resumirErro(error));
    return res.sendStatus(500);
  }
});

app.use((error, _req, res, _next) => {
  console.error("Erro interno:", error);
  res.status(500).json({ erro: "Erro interno do servidor." });
});

app.listen(PORT, () => {
  console.log(`Loja Day Zombi Survival na porta ${PORT}`);
  console.log(`Mercado Pago: ${paymentClient && publicKeyConfigurada ? "OK" : "não configurado"}`);
  console.log(`Firebase Web/Auth: ${firebaseWebConfigurado ? "OK" : "não configurado"}`);
  console.log(`Firebase Admin/Dados: ${firebaseDb && firebaseAuth ? "OK" : "não configurado"}`);
  if (firebaseErroInicializacao) {
    console.log(`Detalhe Firebase Admin: ${resumirErro(firebaseErroInicializacao)}`);
  }
  console.log(`Webhook assinado: ${webhookConfigurado ? "OK" : "não configurado"}`);
});

async function obterUsuarioAutenticado(req, obrigatorio = false) {
  if (!firebaseAuth) {
    const error = new Error("Firebase Admin/Auth não configurado.");
    error.statusCode = 503;
    throw error;
  }

  const authorization = String(req.headers.authorization || "");
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";

  if (!token) {
    if (!obrigatorio) return null;
    const error = new Error("Faça login para continuar.");
    error.statusCode = 401;
    throw error;
  }

  try {
    const decoded = await firebaseAuth.verifyIdToken(token, true);
    return {
      uid: decoded.uid,
      email: decoded.email || "",
      nome: decoded.name || "",
      foto: decoded.picture || "",
      provedor: decoded.firebase?.sign_in_provider || "",
      emailVerificado: Boolean(decoded.email_verified)
    };
  } catch {
    const error = new Error("Sua sessão expirou. Entre novamente.");
    error.statusCode = 401;
    throw error;
  }
}

async function obterContaPorUid(uid) {
  if (!firebaseDb || !uid) return null;
  const snapshot = await firebaseDb.ref(`${FIREBASE_LOGINS_PATH}/USUARIOS/${uid}`).once("value");
  return snapshot.val();
}

async function obterAcessoChavePorUid(uid) {
  if (!firebaseDb || !uid) return null;
  const snapshot = await firebaseDb.ref(
    `${FIREBASE_ACCESS_STORE_PATH}/Usuarios/${uid}/AcessoTeste`
  ).once("value");
  return snapshot.val();
}

/*
 * O projeto Login-main grava e consulta a conta diretamente em:
 * LOGINS_REGISTRADOS/USUARIOS/<firebaseUid>
 * Portanto, a loja usa exatamente a mesma chave.
 */
async function registrarPagamentoNoFirebase(pagamento, produto) {
  if (!firebaseDb) {
    throw new Error("Firebase Admin não configurado.");
  }

  const validacao = validarPagamento(pagamento, produto);
  if (!validacao.identidadeValida) {
    return { registrado: false, motivo: validacao.mensagem, deltaTitulos: 0 };
  }

  const firebaseUid = limparTexto(pagamento?.metadata?.firebase_uid, 160);
  if (!firebaseUid) {
    return { registrado: false, motivo: "Pagamento sem UID de autenticação.", deltaTitulos: 0 };
  }

  let uidConta = limparTexto(pagamento?.metadata?.conta_uid, 160);
  if (!uidConta) uidConta = firebaseUid;
  if (!uidConta) {
    return { registrado: false, motivo: "Conta do jogo não encontrada.", deltaTitulos: 0 };
  }

  const pagamentoId = String(pagamento.id);
  const status = String(pagamento.status || "").toLowerCase();
  const contabilizar = status === "approved" && Number(pagamento.transaction_amount_refunded || 0) <= 0;
  const agora = Date.now();
  const contaRef = firebaseDb.ref(`${FIREBASE_LOGINS_PATH}/USUARIOS/${uidConta}`);
  let deltaAplicado = 0;
  let promocaoBloqueadaPorCompraAnterior = false;

  const resultado = await contaRef.transaction((contaAtual) => {
    if (!contaAtual || typeof contaAtual !== "object" || !contaAtual?.Dados?.nick) {
      return;
    }

    const conta = { ...contaAtual };
    const dados = clonarObjeto(conta.Dados);
    const eventos = clonarObjeto(conta.Eventos);
    const pagamentos = clonarObjeto(eventos.PagamentosLoja);
    const promocoesAdquiridas = clonarObjeto(eventos.PromocoesAdquiridas);
    const existente = clonarObjeto(pagamentos[pagamentoId]);
    const aquisicaoExistente = produto.promocao
      ? clonarObjeto(promocoesAdquiridas[produto.id])
      : {};
    const promocaoAdquiridaPorOutroPagamento = Boolean(
      produto.promocao &&
      contabilizar &&
      aquisicaoExistente?.adquirida &&
      aquisicaoExistente?.pagamentoId &&
      String(aquisicaoExistente.pagamentoId) !== pagamentoId
    );

    promocaoBloqueadaPorCompraAnterior = promocaoAdquiridaPorOutroPagamento;
    const contabilizarEfetivo = contabilizar && !promocaoAdquiridaPorOutroPagamento;
    const titulosProduto = produto.categoria === "titulos" ? Number(produto.titulos) || 0 : 0;
    const titulosAntesAplicados = Number(existente.titulosAplicados) || 0;
    const titulosDesejados = contabilizarEfetivo ? titulosProduto : 0;
    const delta = titulosDesejados - titulosAntesAplicados;
    const saldoAtual = obterSaldoTitulosConta(conta);
    const novoSaldo = Math.max(0, saldoAtual + delta);

    deltaAplicado = novoSaldo - saldoAtual;

    pagamentos[pagamentoId] = {
      ...existente,
      pagamentoId,
      pedidoId: String(pagamento.external_reference || ""),
      produtoId: produto.id,
      produtoTitulo: produto.titulo,
      categoria: produto.categoria || "titulos",
      vendaChave: Boolean(produto.vendaChave),
      valor: produto.valor,
      moeda: produto.moeda,
      titulos: titulosProduto,
      titulosAplicados: titulosDesejados,
      status,
      statusDetalhe: String(pagamento.status_detail || ""),
      contabilizar: contabilizarEfetivo,
      bloqueadoPromocaoJaAdquirida: promocaoAdquiridaPorOutroPagamento,
      aprovadoEm: obterTimestampAprovado(pagamento) || existente.aprovadoEm || null,
      criadoEm: existente.criadoEm || agora,
      atualizadoEm: agora
    };

    if (produto.promocao && contabilizar && !promocaoAdquiridaPorOutroPagamento) {
      promocoesAdquiridas[produto.id] = {
        ...aquisicaoExistente,
        adquirida: true,
        produtoId: produto.id,
        pagamentoId,
        produtoTitulo: produto.titulo,
        valor: produto.valor,
        titulos: titulosProduto,
        adquiridaEm: aquisicaoExistente.adquiridaEm || obterTimestampAprovado(pagamento) || agora,
        atualizadoEm: agora
      };
    }

    conta.Dados = {
      ...dados,
      Titulos: novoSaldo,
      atualizadoEm: agora
    };
    conta.Eventos = {
      ...eventos,
      PagamentosLoja: pagamentos,
      PromocoesAdquiridas: promocoesAdquiridas
    };
    return conta;
  }, undefined, false);

  if (!resultado.committed) {
    return { registrado: false, motivo: "Conta não cadastrada.", deltaTitulos: 0 };
  }

  const saldoTitulos = Number(resultado.snapshot.child("Dados/Titulos").val()) || 0;
  let registroAcesso = null;

  if (produto.vendaChave) {
    registroAcesso = await registrarAcessoChaveDoPagamento(pagamento, produto, contabilizar);
  }

  // Espelho global para auditoria e suporte. Não é usado como fonte do saldo.
  await firebaseDb.ref(`${FIREBASE_STORE_PATH}/Pagamentos/${pagamentoId}`).update({
    pagamentoId,
    uid: uidConta,
    firebaseUid,
    nick: limparTexto(pagamento?.metadata?.nick_conta, 40),
    produtoId: produto.id,
    produtoTitulo: produto.titulo,
    categoria: produto.categoria || "titulos",
    vendaChave: Boolean(produto.vendaChave),
    valor: produto.valor,
    moeda: produto.moeda,
    titulos: produto.categoria === "titulos" ? Number(produto.titulos) || 0 : 0,
    status,
    contabilizar: contabilizar && !promocaoBloqueadaPorCompraAnterior,
    promocaoJaAdquirida: promocaoBloqueadaPorCompraAnterior,
    deltaTitulos: deltaAplicado,
    saldoTitulos,
    acessoGerado: Boolean(registroAcesso?.acessoGerado),
    acessoVinculado: Boolean(registroAcesso?.acessoVinculado),
    pedidoId: String(pagamento.external_reference || ""),
    atualizadoEm: agora
  });

  return {
    registrado: true,
    contabilizar: contabilizar && !promocaoBloqueadaPorCompraAnterior,
    promocaoJaAdquirida: promocaoBloqueadaPorCompraAnterior,
    deltaTitulos: deltaAplicado,
    saldoTitulos,
    acessoGerado: Boolean(registroAcesso?.acessoGerado),
    acessoVinculado: Boolean(registroAcesso?.acessoVinculado)
  };
}

async function registrarAcessoChaveDoPagamento(pagamento, produto, contabilizar) {
  const firebaseUid = limparTexto(pagamento?.metadata?.firebase_uid, 160);
  if (!firebaseUid) {
    return { acessoGerado: false, acessoVinculado: false };
  }

  const pagamentoId = String(pagamento.id);
  const agora = Date.now();
  const firebaseEmail = limparTexto(pagamento?.metadata?.firebase_email, 160);
  const firebaseNome = limparTexto(pagamento?.metadata?.firebase_nome, 160);
  const nick = limparTexto(pagamento?.metadata?.nick_conta, 40);
  const chaveCandidata = contabilizar ? gerarChaveAcesso() : null;
  const lojaRef = firebaseDb.ref(FIREBASE_ACCESS_STORE_PATH);
  let acessoGerado = false;
  let acessoVinculado = false;

  const resultado = await lojaRef.transaction((estadoAtual) => {
    const estado = estadoAtual && typeof estadoAtual === "object"
      ? { ...estadoAtual }
      : {};
    const pagamentos = clonarObjeto(estado.PagamentosProcessados);
    const usuarios = clonarObjeto(estado.Usuarios);
    const chaves = clonarObjeto(estado[FIREBASE_KEYS_PATH]);
    const existentePagamento = clonarObjeto(pagamentos[pagamentoId]);

    if (!contabilizar && !pagamentos[pagamentoId]) {
      return estado;
    }

    pagamentos[pagamentoId] = {
      ...existentePagamento,
      pagamentoId,
      pedidoId: String(pagamento.external_reference || ""),
      produtoId: produto.id,
      tipoApoio: "compra",
      categoria: "chave",
      firebaseUid,
      firebaseEmail: firebaseEmail || existentePagamento.firebaseEmail || "",
      firebaseNome: firebaseNome || existentePagamento.firebaseNome || "",
      nomeApoiador: nick || existentePagamento.nomeApoiador || "",
      valor: produto.valor,
      valorCentavos: Math.round(Number(produto.valor) * 100),
      moeda: produto.moeda,
      status: String(pagamento.status || "").toLowerCase(),
      statusDetalhe: String(pagamento.status_detail || ""),
      contabilizar,
      criadoEm: existentePagamento.criadoEm || agora,
      atualizadoEm: agora
    };

    const usuarioExistente = clonarObjeto(usuarios[firebaseUid]);
    const acessoExistente = clonarObjeto(usuarioExistente.AcessoTeste);
    const comprasAtivas = Object.values(pagamentos).filter((registro) =>
      registro?.firebaseUid === firebaseUid &&
      (registro?.tipoApoio === "compra" || registro?.categoria === "chave") &&
      registro?.contabilizar === true
    );

    if (comprasAtivas.length > 0) {
      const chave = normalizarChaveAcesso(acessoExistente.chave) || chaveCandidata;
      if (!chave) return estado;

      const chaveExistente = clonarObjeto(chaves[chave]);
      const usada = Boolean(chaveExistente.usada || acessoExistente.usada || acessoExistente.usado);
      acessoGerado = Boolean(!acessoExistente.chave);
      acessoVinculado = true;

      usuarios[firebaseUid] = {
        ...usuarioExistente,
        uid: firebaseUid,
        email: firebaseEmail || usuarioExistente.email || "",
        nome: firebaseNome || nick || usuarioExistente.nome || "",
        atualizadoEm: agora,
        AcessoTeste: {
          ...acessoExistente,
          comprado: true,
          ativo: true,
          chave,
          pagamentoId: acessoExistente.pagamentoId || pagamentoId,
          produtoId: produto.id,
          usado: usada,
          usada,
          compradoEm: acessoExistente.compradoEm || agora,
          atualizadoEm: agora,
          revogadoEm: null
        }
      };

      chaves[chave] = {
        ...chaveExistente,
        chave,
        uid: firebaseUid,
        email: firebaseEmail || chaveExistente.email || "",
        nome: firebaseNome || nick || chaveExistente.nome || "",
        pagamentoId: chaveExistente.pagamentoId || pagamentoId,
        produtoId: produto.id,
        ativa: true,
        revogada: false,
        usada,
        usadaPor: chaveExistente.usadaPor || null,
        usadaEm: chaveExistente.usadaEm || null,
        criadaEm: chaveExistente.criadaEm || agora,
        atualizadoEm: agora
      };
    } else {
      const chave = normalizarChaveAcesso(acessoExistente.chave);
      usuarios[firebaseUid] = {
        ...usuarioExistente,
        atualizadoEm: agora,
        AcessoTeste: {
          ...acessoExistente,
          comprado: false,
          ativo: false,
          atualizadoEm: agora,
          revogadoEm: agora
        }
      };

      if (chave && chaves[chave]) {
        chaves[chave] = {
          ...chaves[chave],
          ativa: false,
          revogada: true,
          revogadaEm: agora,
          atualizadoEm: agora
        };
      }
    }

    estado.PagamentosProcessados = pagamentos;
    estado.Usuarios = usuarios;
    estado[FIREBASE_KEYS_PATH] = chaves;
    estado.AtualizadoEm = agora;
    return estado;
  }, undefined, false);

  if (!resultado.committed) {
    return { acessoGerado: false, acessoVinculado: false };
  }

  return { acessoGerado, acessoVinculado };
}

function obterIdsPromocoesAdquiridas(conta) {
  const ids = new Set();
  const marcadores = clonarObjeto(conta?.Eventos?.PromocoesAdquiridas);

  for (const [produtoId, registro] of Object.entries(marcadores)) {
    if (String(produtoId).startsWith("promocao-") && registro?.adquirida) {
      ids.add(String(produtoId));
    }
  }

  // Compatibilidade com compras promocionais feitas antes desta versão,
  // quando ainda não existia o marcador PromocoesAdquiridas.
  const pagamentos = clonarObjeto(conta?.Eventos?.PagamentosLoja);
  for (const item of Object.values(pagamentos)) {
    const produtoId = limparTexto(item?.produtoId, 80);
    if (!produtoId.startsWith("promocao-")) continue;

    if (item?.contabilizar || Number(item?.titulosAplicados) > 0 || String(item?.status || "").toLowerCase() === "approved") {
      ids.add(produtoId);
    }
  }

  return Array.from(ids);
}

function promocaoJaAdquirida(conta, produtoId) {
  return obterIdsPromocoesAdquiridas(conta).includes(String(produtoId || ""));
}

function validarPagamento(pagamento, produtoForcado = null) {
  const produto = produtoForcado || obterProdutoDoPagamento(pagamento);
  if (!produto) {
    return { identidadeValida: false, aprovado: false, mensagem: "Produto não reconhecido." };
  }

  const referencia = String(pagamento?.external_reference || "");
  const valorCorreto = Math.abs(Number(pagamento?.transaction_amount) - produto.valor) < 0.00001;
  const moedaCorreta = String(pagamento?.currency_id || "") === produto.moeda;
  const referenciaCorreta = referencia.startsWith(`dzstore-${produto.id}-`);
  const identidadeValida = valorCorreto && moedaCorreta && referenciaCorreta;
  const status = String(pagamento?.status || "").toLowerCase();
  const naoEstornado = Number(pagamento?.transaction_amount_refunded || 0) <= 0;

  if (!identidadeValida) {
    return {
      identidadeValida: false,
      aprovado: false,
      mensagem: "Os dados do pagamento não correspondem ao produto escolhido."
    };
  }

  if (status !== "approved" || !naoEstornado) {
    return {
      identidadeValida: true,
      aprovado: false,
      mensagem: mensagemPorStatus(status)
    };
  }

  return {
    identidadeValida: true,
    aprovado: true,
    mensagem: produto.vendaChave
      ? "Pagamento aprovado. Sua chave de acesso foi liberada."
      : "Pagamento aprovado. Os Títulos foram creditados."
  };
}

function resumirPagamento(pagamento, registro = null) {
  const produto = obterProdutoDoPagamento(pagamento);
  const validacao = validarPagamento(pagamento, produto);
  const transactionData = pagamento?.point_of_interaction?.transaction_data || {};
  const isPix = String(pagamento?.payment_method_id || "").toLowerCase() === "pix";

  const promocaoJaAdquirida = Boolean(registro?.promocaoJaAdquirida);

  return {
    aprovado: validacao.aprovado && !promocaoJaAdquirida,
    identidadeValida: validacao.identidadeValida,
    pagamentoId: pagamento?.id ? String(pagamento.id) : null,
    pedidoId: pagamento?.external_reference || null,
    status: String(pagamento?.status || "desconhecido"),
    statusDetalhe: pagamento?.status_detail || null,
    valor: pagamento?.transaction_amount ?? null,
    moeda: pagamento?.currency_id || null,
    produtoId: produto?.id || null,
    produtoTitulo: produto?.titulo || null,
    categoria: produto?.categoria || null,
    vendaChave: Boolean(produto?.vendaChave),
    titulos: promocaoJaAdquirida ? 0 : (produto?.titulos || 0),
    saldoTitulos: registro?.saldoTitulos ?? null,
    deltaTitulos: registro?.deltaTitulos ?? 0,
    acessoGerado: Boolean(registro?.acessoGerado),
    acessoVinculado: Boolean(registro?.acessoVinculado),
    mensagem: promocaoJaAdquirida
      ? "Este pacote promocional já havia sido adquirido por esta conta."
      : validacao.mensagem,
    pix: isPix ? {
      qrCode: transactionData.qr_code || null,
      qrCodeBase64: transactionData.qr_code_base64 || null,
      expiracao: pagamento?.date_of_expiration || null
    } : null
  };
}

function obterProdutoDoPagamento(pagamento) {
  const metadata = pagamento?.metadata || {};
  const id = limparTexto(metadata.produto_id, 80);
  if (PRODUTOS[id]) return PRODUTOS[id];

  // A venda de chave é dinâmica. O snapshot salvo no próprio pagamento
  // permite confirmar o preço mesmo se a oferta já tiver sido removida.
  const ehVendaChave = metadata.venda_chave === true || String(metadata.venda_chave).toLowerCase() === "true";
  if (ehVendaChave && id === KEY_PRODUCT_ID) {
    const titulo = limparTexto(metadata.chave_titulo, 100) || "Chave de acesso Day Zombi";
    const descricao = limparTexto(metadata.chave_descricao, 160);
    const valor = Number(metadata.chave_valor);
    const promocional = metadata.chave_promocional === true || String(metadata.chave_promocional).toLowerCase() === "true";
    const expiraEm = Number(metadata.chave_expira_em) || 0;

    if (!descricao || !Number.isFinite(valor) || valor <= 0) return null;
    return criarProdutoVendaChave({ titulo, descricao, valor, promocional, expiraEm }, false);
  }

  // O webhook pode chegar muito depois e a promoção atual já ter sido
  // substituída. Por isso o próprio pagamento guarda um snapshot imutável.
  const ehPromocao = metadata.promocao === true || String(metadata.promocao).toLowerCase() === "true";
  if (!ehPromocao || !id.startsWith("promocao-")) return null;

  const versao = limparTexto(metadata.promocao_versao, 40);
  const descricao = limparTexto(metadata.promocao_descricao, 160);
  const valor = Number(metadata.promocao_valor);
  const titulos = Number(metadata.promocao_titulos);

  if (!versao || id !== `promocao-${versao}`) return null;
  if (!descricao || !Number.isFinite(valor) || valor <= 0) return null;
  if (!Number.isInteger(titulos) || titulos <= 0) return null;

  return criarProdutoPromocional({ descricao, valor, titulos, versao });
}

async function obterCatalogoPublico() {
  const catalogoNormal = Object.values(PRODUTOS).map(produtoPublico);
  if (!firebaseDb) return catalogoNormal;

  try {
    const promocoes = await obterPromocoesAtivas();
    return [...catalogoNormal, ...promocoes.map(produtoPublico)];
  } catch (error) {
    console.error("Falha ao carregar promoções:", resumirErro(error));
    return catalogoNormal;
  }
}

async function obterVendaChavePublica() {
  if (!firebaseDb) return null;
  try {
    const produto = await obterVendaChaveAtiva();
    return produto ? produtoPublico(produto) : null;
  } catch (error) {
    console.error("Falha ao carregar venda de chave:", resumirErro(error));
    return null;
  }
}

async function obterVendaChaveAtiva() {
  if (!firebaseDb) return null;
  const snapshot = await firebaseDb.ref(FIREBASE_KEY_SALE_PATH).once("value");
  return criarProdutoVendaChave(snapshot.val(), true);
}

function criarProdutoVendaChave(valor, validarPrazo = true) {
  if (!valor || typeof valor !== "object") return null;
  if (valor.ativa === false) return null;

  const promocional = Boolean(valor.promocional);
  const titulo = limparTexto(valor.titulo, 100) || (
    promocional ? "Compra de chave promocional" : "Chave de acesso Day Zombi"
  );
  const descricao = limparTexto(valor.descricao, 160) || "Chave de acesso às versões de teste do Day Zombi Survival.";
  const preco = Number(valor.valor);
  const expiraEm = Number(valor.expiraEm) || 0;
  const criadoEm = Number(valor.criadoEm) || 0;
  const atualizadoEm = Number(valor.atualizadoEm) || criadoEm;

  if (validarPrazo && expiraEm && expiraEm <= Date.now()) return null;
  if (!Number.isFinite(preco) || preco <= 0 || preco > 100000) return null;

  return {
    id: KEY_PRODUCT_ID,
    titulo,
    descricao,
    categoria: "chave",
    valor: Math.round(preco * 100) / 100,
    moeda: "BRL",
    titulos: 0,
    destaque: true,
    badge: promocional ? "Chave promocional" : "Chave de acesso",
    promocao: false,
    vendaChave: true,
    promocional,
    criadoEm,
    atualizadoEm,
    expiraEm
  };
}

async function obterPromocoesAtivas() {
  if (!firebaseDb) return [];

  const snapshot = await firebaseDb.ref(FIREBASE_PROMOS_PATH).once("value");
  const promocoes = [];

  snapshot.forEach((child) => {
    const promocao = criarProdutoPromocional(child.val(), child.key);
    if (promocao) promocoes.push(promocao);
  });

  // Compatibilidade com a primeira versão do painel. Se ainda existir uma
  // PromocaoAtual antiga, ela continua aparecendo até ser migrada/removida.
  const legadoSnapshot = await firebaseDb.ref(FIREBASE_PROMO_LEGACY_PATH).once("value");
  const legado = criarProdutoPromocional(legadoSnapshot.val(), "legado");
  if (legado) promocoes.push(legado);

  return promocoes.sort((a, b) => Number(b.atualizadoEm || b.criadoEm || 0) - Number(a.atualizadoEm || a.criadoEm || 0));
}

async function obterPromocaoPorId(produtoId) {
  if (!firebaseDb) return null;
  const prefixo = "promocao-";
  if (!String(produtoId || "").startsWith(prefixo)) return null;

  const versao = limparTexto(String(produtoId).slice(prefixo.length), 80);
  if (!versao || !/^[A-Za-z0-9_-]+$/.test(versao)) return null;

  if (versao === "legado") {
    const snapshot = await firebaseDb.ref(FIREBASE_PROMO_LEGACY_PATH).once("value");
    return criarProdutoPromocional(snapshot.val(), "legado");
  }

  const snapshot = await firebaseDb.ref(`${FIREBASE_PROMOS_PATH}/${versao}`).once("value");
  return criarProdutoPromocional(snapshot.val(), versao);
}

function criarProdutoPromocional(valor, idFirebase = "") {
  if (!valor || typeof valor !== "object") return null;

  const descricao = limparTexto(valor.descricao, 160);
  const preco = Number(valor.valor);
  const titulos = Number(valor.titulos);
  const versao = limparTexto(idFirebase || valor.versao, 80);
  const criadoEm = Number(valor.criadoEm) || 0;
  const atualizadoEm = Number(valor.atualizadoEm) || criadoEm;
  const expiraEm = Number(valor.expiraEm) || 0;

  // Promoções antigas sem expiraEm continuam válidas por compatibilidade.
  // Promoções novas desaparecem automaticamente assim que o prazo termina.
  if (expiraEm && expiraEm <= Date.now()) return null;

  if (!descricao || !versao) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(versao)) return null;
  if (!Number.isFinite(preco) || preco <= 0 || preco > 100000) return null;
  if (!Number.isInteger(titulos) || titulos <= 0 || titulos > 100000000) return null;

  const precoFinal = Math.round(preco * 100) / 100;

  return {
    id: `promocao-${versao}`,
    titulo: `${titulos.toLocaleString("pt-BR")} Títulos`,
    descricao,
    categoria: "titulos",
    valor: precoFinal,
    moeda: "BRL",
    titulos,
    destaque: false,
    badge: "Promoção",
    promocao: true,
    versao,
    criadoEm,
    atualizadoEm,
    expiraEm
  };
}

function produtoPublico(produto) {
  return {
    id: produto.id,
    titulo: produto.titulo,
    descricao: produto.descricao,
    categoria: produto.categoria,
    valor: produto.valor,
    moeda: produto.moeda,
    titulos: produto.titulos,
    destaque: Boolean(produto.destaque),
    badge: produto.badge || "",
    promocao: Boolean(produto.promocao),
    vendaChave: Boolean(produto.vendaChave),
    promocional: Boolean(produto.promocional),
    expiraEm: Number(produto.expiraEm) || 0
  };
}

function obterSaldoTitulosConta(conta) {
  const dados = conta?.Dados && typeof conta.Dados === "object" ? conta.Dados : {};

  if (dados.Titulos !== undefined && dados.Titulos !== null) {
    const titulos = Number(dados.Titulos);
    return Number.isFinite(titulos) ? Math.max(0, titulos) : 0;
  }

  // Compatibilidade com contas antigas do jogo, que ainda podem ter Dados/Dolls.
  const dollsLegado = Number(dados.Dolls);
  return Number.isFinite(dollsLegado) ? Math.max(0, dollsLegado) : 0;
}

function contaPublica(conta) {
  if (!conta || typeof conta !== "object") return null;
  return {
    nick: conta?.Dados?.nick || "",
    foto: conta?.Dados?.googleFoto || "",
    saldoTitulos: obterSaldoTitulosConta(conta)
  };
}

function usuarioPublico(usuario) {
  return {
    uid: usuario.uid,
    email: usuario.email || "",
    nome: usuario.nome || "",
    foto: usuario.foto || ""
  };
}

function normalizarNickConta(valor) {
  const nick = String(valor || "").trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]{2,19}$/u.test(nick)) return null;
  return { nick, nickKey: nick.toLocaleLowerCase("pt-BR") };
}

function sanitizarPagador(valor) {
  const payer = valor && typeof valor === "object" ? valor : {};
  const out = {};
  const email = String(payer.email || "").trim().slice(0, 160);
  if (email) out.email = email;

  const identification = payer.identification && typeof payer.identification === "object"
    ? payer.identification
    : null;
  if (identification?.type && identification?.number) {
    out.identification = {
      type: String(identification.type).slice(0, 20),
      number: String(identification.number).replace(/\D/g, "").slice(0, 24)
    };
  }

  const firstName = limparTexto(payer.first_name, 80);
  const lastName = limparTexto(payer.last_name, 80);
  if (firstName) out.first_name = firstName;
  if (lastName) out.last_name = lastName;
  return out;
}

function carregarCredencialFirebase() {
  // Mesmo formato aceito pelo backend oficial de Login.
  // Pode receber JSON puro ou o JSON codificado em Base64.
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

  // Também aceita as três variáveis separadas usadas em muitos ambientes.
  const projectId = String(process.env.FIREBASE_PROJECT_ID || "").trim();
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || "").trim();
  const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || "")
    .replace(/\\n/g, "\n")
    .trim();

  if (projectId && clientEmail && privateKey) {
    return cert({ projectId, clientEmail, privateKey });
  }

  const filePath = String(
    process.env.GOOGLE_APPLICATION_CREDENTIALS || ""
  ).trim();

  if (filePath && fs.existsSync(filePath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(filePath, "utf8"));
    serviceAccount.private_key = String(serviceAccount.private_key || "")
      .replace(/\\n/g, "\n");
    return cert(serviceAccount);
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return applicationDefault();
  }

  return null;
}

function responderErroAutenticacao(res, error) {
  return res.status(Number(error?.statusCode) || 401).json({
    autenticado: false,
    erro: error?.message || "Falha de autenticação."
  });
}

function obterTimestampAprovado(pagamento) {
  const valor = pagamento?.date_approved || pagamento?.date_last_updated || null;
  const timestamp = valor ? Date.parse(valor) : NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}

function mensagemPorStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s === "pending" || s === "in_process") return "Pagamento aguardando confirmação.";
  if (s === "rejected") return "Pagamento recusado.";
  if (s === "cancelled") return "Pagamento cancelado.";
  if (s === "refunded") return "Pagamento estornado. O benefício da compra foi revertido.";
  if (s === "charged_back") return "Pagamento contestado. O benefício da compra foi revertido.";
  return "Pagamento ainda não aprovado.";
}

function gerarChaveAcesso() {
  const partes = crypto.randomBytes(12)
    .toString("hex")
    .toUpperCase()
    .match(/.{1,4}/g)
    .slice(0, 6);
  return `CHAVE-PLAYER-TESTE-${partes.join("-")}`;
}

function normalizarChaveAcesso(valor) {
  const chave = String(valor || "").trim().toUpperCase();
  return /^CHAVE-PLAYER-TESTE(?:-[A-F0-9]{4}){6}$/.test(chave)
    ? chave
    : "";
}

function normalizarIdentificadorJogador(valor) {
  return String(valor || "")
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9:_-]/g, "")
    .slice(0, 100);
}

function normalizarUrlExterna(valor) {
  const url = String(valor || "").trim();
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function normalizarUrlPublica(valor) {
  const url = String(valor || "").trim();
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function extrairIdPagamento(valor) {
  const id = String(valor || "").trim();
  return /^\d{3,30}$/.test(id) ? id : null;
}

function extrairChaveIdempotencia(valor) {
  const key = String(valor || "").trim();
  return /^[A-Za-z0-9._:-]{16,120}$/.test(key) ? key : null;
}

function limparTexto(valor, limite = 160) {
  return String(valor || "").trim().slice(0, limite);
}

function clonarObjeto(valor) {
  return valor && typeof valor === "object" ? { ...valor } : {};
}

function extrairStatusErro(error) {
  const status = Number(error?.status || error?.statusCode || error?.cause?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

function extrairDetalheSeguro(error) {
  const message = String(error?.message || "").slice(0, 250);
  return process.env.NODE_ENV === "production" ? undefined : message || undefined;
}

function mensagemAmigavelDoErro(error) {
  const status = extrairStatusErro(error);
  if (status === 400) return "Os dados do pagamento não foram aceitos. Revise as informações.";
  if (status === 401 || status === 403) return "O serviço de pagamento está temporariamente indisponível.";
  if (status === 429) return "Muitas tentativas. Aguarde um pouco e tente novamente.";
  return "Não foi possível iniciar o pagamento agora.";
}

function resumirErro(error) {
  return String(error?.message || error || "Erro desconhecido").slice(0, 500);
}
