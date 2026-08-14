const els = {};
const state = {
  config: null,
  auth: null,
  user: null,
  account: null,
  wallet: null,
  access: null,
  mp: null,
  brickController: null,
  currentProduct: null,
  paymentPoll: null,
  pendingPaymentId: null,
  activeStoreTab: "normal",
  storeTabInitialized: false,
  promoNewsShown: false
};

window.addEventListener("DOMContentLoaded", init);

async function init() {
  cacheElements();
  bindEvents();
  startBackgroundSlideshow();

  try {
    await loadConfig();
    renderProducts();
    renderKeySale();
    showPromoNewsIfNeeded();
    startProductSync();
    startPromotionCountdowns();
    await initFirebaseAuth();
  } catch (error) {
    console.error(error);
    showToast(error.message || "Não foi possível iniciar a loja.");
    renderProducts();
    renderKeySale();
  }
}

function cacheElements() {
  [
    "accountButton", "accountText", "accountAvatar", "heroAccountButton",
    "walletBalance", "walletNick", "productGrid", "authModal", "googleLoginButton",
    "authError", "nickModal", "nickForm", "nickInput", "nickError", "accountModal",
    "accountModalAvatar", "accountEmail", "accountNick", "accountBalance", "purchaseHistory",
    "refreshWalletButton", "logoutButton", "logoutNickButton", "checkoutModal", "checkoutTitle", "checkoutDescription",
    "checkoutPrice", "checkoutIcon", "paymentBrickContainer", "paymentResult", "toast", "normalTab", "promoTab", "promoTabCount",
    "promoNewsModal", "promoNewsText", "promoNewsCloseButton", "promoNewsViewButton",
    "keySaleBanner", "keySaleBannerTitle", "keySaleBannerDescription", "keySaleBannerTimer", "keySaleViewButton",
    "keySaleModal", "keySaleEyebrow", "keySaleTitle", "keySaleDescription", "keySalePrice", "keySaleTimer", "keySaleBuyButton", "keySaleOwnedButton",
    "accessModal", "accessKeyValue", "copyAccessKeyButton", "accessKeyStatus", "accessTelegram", "accessDownload", "accessDownloadNote"
  ].forEach((id) => { els[id] = document.getElementById(id); });
}

function bindEvents() {
  els.accountButton.addEventListener("click", onAccountClick);
  els.heroAccountButton.addEventListener("click", onAccountClick);
  els.googleLoginButton.addEventListener("click", signInGoogle);
  els.nickForm.addEventListener("submit", saveNick);
  els.refreshWalletButton.addEventListener("click", refreshWallet);
  els.logoutButton.addEventListener("click", signOut);
  els.logoutNickButton.addEventListener("click", signOut);
  els.normalTab.addEventListener("click", () => setStoreTab("normal"));
  els.promoTab.addEventListener("click", () => setStoreTab("promocoes"));
  els.promoNewsCloseButton.addEventListener("click", () => closeModal(els.promoNewsModal));
  els.keySaleViewButton.addEventListener("click", openKeySaleModal);
  els.keySaleBuyButton.addEventListener("click", () => beginPurchase(state.config?.vendaChave?.id));
  els.keySaleOwnedButton.addEventListener("click", openAccessModal);
  els.copyAccessKeyButton.addEventListener("click", copyAccessKey);
  els.promoNewsViewButton.addEventListener("click", () => {
    setStoreTab("promocoes");
    closeModal(els.promoNewsModal);
    document.getElementById("loja")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  document.addEventListener("click", (event) => {
    const close = event.target.closest("[data-close]");
    if (!close) return;
    const type = close.dataset.close;
    if (type === "auth") closeModal(els.authModal);
    if (type === "account") closeModal(els.accountModal);
    if (type === "checkout") closeCheckout();
    if (type === "promoNews") closeModal(els.promoNewsModal);
    if (type === "keySale") closeModal(els.keySaleModal);
    if (type === "access") closeModal(els.accessModal);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    [els.authModal, els.accountModal, els.promoNewsModal, els.keySaleModal, els.accessModal].forEach(closeModal);
    if (!els.checkoutModal.hidden) closeCheckout();
  });
}

async function loadConfig() {
  const response = await fetch("/api/configuracao-publica", { cache: "no-store" });
  if (!response.ok) throw new Error("Configuração da loja indisponível.");
  state.config = await response.json();

  if (state.config.publicKey && window.MercadoPago) {
    state.mp = new MercadoPago(state.config.publicKey, { locale: "pt-BR" });
  }
}


async function refreshProducts() {
  try {
    const response = await fetch("/api/produtos", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    if (!Array.isArray(data.produtos) || !state.config) return;
    state.config.produtos = data.produtos;
    state.config.vendaChave = data.vendaChave || null;
    renderProducts();
    renderKeySale();
  } catch (_) {
    // A loja continua usando o catálogo que já está na tela.
  }
}

function startProductSync() {
  window.setInterval(refreshProducts, 10000);
}

async function initFirebaseAuth() {
  // O login Google acontece no navegador pelo SDK Web do Firebase.
  // Ele NÃO depende do Firebase Admin do servidor estar inicializado.
  if (!state.config?.firebaseWebConfig || !window.firebase) {
    els.accountText.textContent = "Login indisponível";
    els.accountButton.disabled = true;
    if (els.heroAccountButton) els.heroAccountButton.disabled = true;
    if (els.authError) {
      els.authError.textContent = "A configuração de login não foi carregada.";
    }
    console.error("[Login] Firebase Web não está disponível.", {
      possuiConfig: Boolean(state.config?.firebaseWebConfig),
      possuiSdk: Boolean(window.firebase)
    });
    return;
  }

  try {
    if (!firebase.apps.length) {
      firebase.initializeApp(state.config.firebaseWebConfig);
    }

    state.auth = firebase.auth();
    state.auth.useDeviceLanguage();

    // Mantém a sessão ao recarregar a página.
    await state.auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

    els.accountButton.disabled = false;
    if (els.heroAccountButton) els.heroAccountButton.disabled = false;
    if (els.googleLoginButton) els.googleLoginButton.disabled = false;

    state.auth.onAuthStateChanged(async (user) => {
      state.user = user || null;
      if (!user) {
        state.account = null;
        state.wallet = null;
        state.access = null;
        renderLoggedOut();
        return;
      }

      renderUserShell(user);
      await loadAccountState();
    });
  } catch (error) {
    state.auth = null;
    console.error("[Login] Falha ao inicializar Firebase Auth:", error);
    els.accountText.textContent = "Login indisponível";
    if (els.authError) {
      els.authError.textContent = firebaseErrorMessage(error, true);
    }
  }
}

async function signInGoogle() {
  els.authError.textContent = "";

  if (!state.auth) {
    els.authError.textContent = "O login ainda não foi inicializado. Recarregue a página.";
    console.error("[Login] Clique recebido, mas state.auth está vazio.");
    return;
  }

  const textoOriginal = els.googleLoginButton.textContent;
  els.googleLoginButton.disabled = true;
  els.googleLoginButton.textContent = "Abrindo login...";

  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await state.auth.signInWithPopup(provider);
    closeModal(els.authModal);
  } catch (error) {
    console.error("[Login] Falha no login Google:", error);
    els.authError.textContent = firebaseErrorMessage(error);
  } finally {
    els.googleLoginButton.disabled = false;
    els.googleLoginButton.textContent = textoOriginal;
  }
}

async function signOut() {
  if (!state.auth) return;

  try {
    sessionStorage.removeItem("pendingProduct");
    await state.auth.signOut();
    closeModal(els.nickModal);
    closeModal(els.accountModal);
    showToast("Você saiu da conta.");
  } catch (error) {
    console.error(error);
    showToast("Não foi possível sair da conta. Tente novamente.");
  }
}

async function onAccountClick() {
  if (!state.user) {
    openModal(els.authModal);
    return;
  }

  // Se a conta ainda não foi consultada, tenta novamente. Uma falha do
  // backend não pode ser interpretada como "usuário sem Nick".
  if (!state.account) {
    await loadAccountState();
    if (!state.account) return;
  }

  if (state.account.indisponivel) {
    showToast("Não foi possível consultar os dados da conta agora.");
    return;
  }

  if (!state.account.cadastrado) {
    openModal(els.nickModal);
    return;
  }

  await refreshWallet();
  openModal(els.accountModal);
}

async function loadAccountState() {
  try {
    const data = await apiFetch("/api/minha-conta");
    state.account = data;

    if (!data.cadastrado) {
      renderUserShell(state.user, "Escolha seu Nick");
      openModal(els.nickModal);
      return;
    }

    await refreshWallet();
    renderUserShell(state.user, data.conta?.nick || state.user.displayName || "Conta");
  } catch (error) {
    console.warn(error);
    state.account = { indisponivel: true, cadastrado: null, conta: null };
    renderUserShell(state.user, state.user?.displayName || "Minha conta");
    showToast(error.message);
  }
}

async function saveNick(event) {
  event.preventDefault();
  els.nickError.textContent = "";
  const nick = els.nickInput.value.trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]{2,19}$/u.test(nick)) {
    els.nickError.textContent = "Use de 3 a 20 caracteres: letras, números, _ ou -.";
    return;
  }

  try {
    const data = await apiFetch("/api/cadastrar-conta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nick })
    });
    state.account = data;
    closeModal(els.nickModal);
    els.nickInput.value = "";
    await refreshWallet();
    renderUserShell(state.user, data.conta?.nick || nick);
    showToast(`Nick ${data.conta?.nick || nick} vinculado à conta.`);
  } catch (error) {
    els.nickError.textContent = error.message;
  }
}

async function refreshWallet() {
  if (!state.user || !state.account?.cadastrado) return;
  try {
    state.wallet = await apiFetch("/api/minha-carteira");
    renderWallet();
    renderHistory();
    renderProducts();
    renderKeySale();
  } catch (error) {
    console.warn(error);
    showToast(error.message);
  }
}

function renderLoggedOut() {
  els.accountText.textContent = "Entrar na conta";
  renderAvatar(els.accountAvatar, null, "G");
  renderAvatar(els.accountModalAvatar, null, "G");
  els.walletBalance.textContent = "—";
  els.walletNick.textContent = "Entre na sua conta para consultar o saldo.";
  renderProducts();
  renderKeySale();
}

function renderUserShell(user, label = null) {
  els.accountText.textContent = label || user.displayName || "Minha conta";
  renderAvatar(els.accountAvatar, user.photoURL, firstLetter(label || user.displayName || "G"));
  renderAvatar(els.accountModalAvatar, user.photoURL, firstLetter(label || user.displayName || "G"));
  els.accountEmail.textContent = user.email || "—";
}

function renderWallet() {
  if (!state.wallet) return;
  const saldo = Number(state.wallet.saldoTitulos) || 0;
  els.walletBalance.textContent = formatNumber(saldo);
  els.walletNick.textContent = `${state.wallet.nick} • saldo sincronizado`;
  els.accountNick.textContent = state.wallet.nick || "—";
  els.accountBalance.textContent = formatNumber(saldo);
}

function renderHistory() {
  const historyRaw = state.wallet?.historico || [];
  const history = state.config?.vendaChave
    ? historyRaw
    : historyRaw.filter((item) => !(item.vendaChave || item.categoria === "chave"));
  if (!history.length) {
    els.purchaseHistory.innerHTML = '<p class="muted">Você ainda não possui compras registradas.</p>';
    return;
  }

  els.purchaseHistory.innerHTML = history.map((item) => {
    const statusClass = item.contabilizar ? "status-approved" : statusCss(item.status);
    const statusText = item.contabilizar ? "Aprovado" : statusLabel(item.status);
    const date = item.aprovadoEm || item.atualizadoEm;
    return `
      <article class="history-item">
        <div>
          <strong>${escapeHtml(item.produtoTitulo || item.produtoId || "Compra")}</strong>
          <small>${date ? new Date(date).toLocaleString("pt-BR") : "—"} • ${formatMoney(item.valor, item.moeda)}</small>
        </div>
        <div class="history-item__right">
          <b>${item.vendaChave || item.categoria === "chave"
            ? "Chave"
            : `${item.contabilizar ? "+" : ""}${formatNumber(item.titulos)} T`}</b>
          <span class="${statusClass}">${statusText}</span>
        </div>
      </article>`;
  }).join("");
}

function renderProducts() {
  const allProducts = state.config?.produtos || [];
  const promotions = allProducts.filter((product) => product.promocao);
  const normalProducts = allProducts.filter((product) => !product.promocao);

  // Promoções têm prioridade: quando existem, a loja abre nessa aba.
  if (!state.storeTabInitialized) {
    state.activeStoreTab = promotions.length ? "promocoes" : "normal";
    state.storeTabInitialized = true;
  }
  if (state.activeStoreTab === "promocoes" && !promotions.length) {
    state.activeStoreTab = "normal";
  }

  const isPromotions = state.activeStoreTab === "promocoes";
  const products = isPromotions ? promotions : normalProducts;

  els.normalTab.classList.toggle("is-active", !isPromotions);
  els.promoTab.classList.toggle("is-active", isPromotions);
  els.normalTab.setAttribute("aria-selected", String(!isPromotions));
  els.promoTab.setAttribute("aria-selected", String(isPromotions));
  els.promoTabCount.textContent = String(promotions.length);
  els.promoTab.classList.toggle("has-promotions", promotions.length > 0);

  if (!products.length) {
    els.productGrid.innerHTML = isPromotions
      ? '<div class="store-empty"><strong>Nenhuma promoção disponível.</strong><span>Quando uma promoção for lançada, ela aparecerá aqui.</span></div>'
      : '<div class="store-empty"><strong>Nenhum pacote disponível.</strong><span>Tente novamente em alguns instantes.</span></div>';
    return;
  }

  els.productGrid.innerHTML = products.map((product) => {
    const acquired = Boolean(product.promocao && isPromotionPurchased(product.id));
    return `
      <article class="product-card ${product.destaque ? "product-card--featured" : ""} ${product.promocao ? "product-card--promo" : ""} ${acquired ? "product-card--acquired" : ""}">
        <span class="product-card__badge">${escapeHtml(acquired ? "Adquirido" : (product.badge || "Pacote"))}</span>
        <div class="product-card__main">
          <img class="product-card__icon" src="/assets/Icone_Titulos.png" alt="">
          <div class="product-card__copy">
            <h3>${escapeHtml(product.titulo)}</h3>
            <p>${escapeHtml(product.descricao)}</p>
          </div>
        </div>
        ${product.promocao && product.expiraEm ? `<div class="product-card__timer" data-promo-expira="${Number(product.expiraEm)}">${formatPromotionRemaining(product.expiraEm)}</div>` : ""}
        <div class="product-card__price"><strong>${formatMoney(product.valor, product.moeda)}</strong><span>pagamento único</span></div>
        <button class="button ${acquired ? "button--acquired" : "button--primary"}" type="button" ${acquired ? "disabled" : `data-buy="${escapeHtml(product.id)}"`}>${acquired ? "Pacote já adquirido" : "Comprar"}</button>
      </article>`;
  }).join("");

  els.productGrid.querySelectorAll("[data-buy]").forEach((button) => {
    button.addEventListener("click", () => beginPurchase(button.dataset.buy));
  });
}

function renderKeySale() {
  const sale = state.config?.vendaChave || null;

  if (!sale) {
    els.keySaleBanner.hidden = true;
    if (!els.keySaleModal.hidden) closeModal(els.keySaleModal);
    if (!els.accessModal.hidden) closeModal(els.accessModal);
    return;
  }

  const owned = Boolean(state.wallet?.acessoComprado);
  els.keySaleBanner.hidden = false;
  els.keySaleBannerTitle.textContent = sale.titulo || (sale.promocional ? "Compra de chave promocional" : "Chave de acesso Day Zombi");
  els.keySaleBannerDescription.textContent = sale.descricao || "Chave de acesso disponível.";

  const timerText = sale.expiraEm ? formatKeySaleRemaining(sale.expiraEm) : "";
  els.keySaleBannerTimer.hidden = !timerText;
  els.keySaleBannerTimer.textContent = timerText;

  els.keySaleEyebrow.textContent = sale.promocional ? "OFERTA DE CHAVE" : "CHAVE DE ACESSO";
  els.keySaleTitle.textContent = sale.titulo || "Chave de acesso Day Zombi";
  els.keySaleDescription.textContent = sale.descricao || "Chave de acesso disponível.";
  els.keySalePrice.textContent = formatMoney(sale.valor, sale.moeda);
  els.keySaleTimer.hidden = !timerText;
  els.keySaleTimer.textContent = timerText;

  els.keySaleBuyButton.hidden = owned;
  els.keySaleOwnedButton.hidden = !owned;
  els.keySaleViewButton.textContent = owned ? "Ver minha chave" : "Ver oferta";
}

function openKeySaleModal() {
  const sale = state.config?.vendaChave;
  if (!sale) return;

  if (state.wallet?.acessoComprado) {
    openAccessModal();
    return;
  }

  renderKeySale();
  openModal(els.keySaleModal);
}

async function openAccessModal() {
  // Se a venda foi removida pelo painel, a loja não mostra nada de chave.
  if (!state.config?.vendaChave) return;

  if (!state.user) {
    openModal(els.authModal);
    return;
  }

  if (!state.account?.cadastrado) {
    openModal(els.nickModal);
    return;
  }

  try {
    const data = await apiFetch("/api/meu-acesso");
    if (!data.comprado || !data.acesso?.chave) {
      showToast("Sua conta ainda não possui uma chave de acesso.");
      return;
    }

    state.access = data.acesso;
    els.accessKeyValue.textContent = data.acesso.chave;
    els.accessKeyStatus.textContent = data.acesso.usada
      ? "Esta chave já foi ativada no jogo."
      : "Chave pronta para ser ativada no jogo.";

    if (data.acesso.telegramUrl) {
      els.accessTelegram.href = data.acesso.telegramUrl;
      els.accessTelegram.hidden = false;
    } else {
      els.accessTelegram.hidden = true;
      els.accessTelegram.removeAttribute("href");
    }

    if (data.acesso.downloadDisponivel && data.acesso.downloadUrl) {
      els.accessDownload.href = data.acesso.downloadUrl;
      els.accessDownload.hidden = false;
      els.accessDownloadNote.textContent = "A versão de teste configurada para sua conta está disponível.";
    } else {
      els.accessDownload.hidden = true;
      els.accessDownload.removeAttribute("href");
      els.accessDownloadNote.textContent = "";
    }

    closeModal(els.keySaleModal);
    openModal(els.accessModal);
  } catch (error) {
    showToast(error.message || "Não foi possível carregar sua chave.");
  }
}

async function copyAccessKey() {
  const chave = String(els.accessKeyValue.textContent || "").trim();
  if (!chave || chave === "—") return;

  try {
    await navigator.clipboard.writeText(chave);
    showToast("Chave copiada.");
  } catch {
    const area = document.createElement("textarea");
    area.value = chave;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    showToast("Chave copiada.");
  }
}

function formatKeySaleRemaining(expiraEm) {
  const texto = formatPromotionRemaining(expiraEm);
  if (!texto) return "";
  if (texto === "Promoção encerrada") return "Oferta encerrada";
  return texto.replace(/^Termina em /, "Oferta termina em ");
}

function isPromotionPurchased(productId) {
  const ids = Array.isArray(state.wallet?.promocoesAdquiridas)
    ? state.wallet.promocoesAdquiridas
    : [];
  return ids.includes(String(productId || ""));
}

function startPromotionCountdowns() {
  window.setInterval(() => {
    let precisaAtualizar = false;

    document.querySelectorAll("[data-promo-expira]").forEach((el) => {
      const expiraEm = Number(el.dataset.promoExpira) || 0;
      const restante = expiraEm - Date.now();
      el.textContent = formatPromotionRemaining(expiraEm);

      if (expiraEm && restante <= 0 && el.dataset.expirada !== "1") {
        el.dataset.expirada = "1";
        const card = el.closest(".product-card");
        const comprar = card?.querySelector("[data-buy]");
        if (comprar) {
          comprar.disabled = true;
          comprar.textContent = "PROMOÇÃO ENCERRADA";
        }
        precisaAtualizar = true;
      }
    });

    const sale = state.config?.vendaChave;
    if (sale?.expiraEm) {
      const timerText = formatKeySaleRemaining(sale.expiraEm);
      els.keySaleBannerTimer.textContent = timerText;
      els.keySaleTimer.textContent = timerText;
      if (Number(sale.expiraEm) <= Date.now()) precisaAtualizar = true;
    }

    if (precisaAtualizar) refreshProducts();
  }, 1000);
}

function formatPromotionRemaining(expiraEm) {
  const fim = Number(expiraEm) || 0;
  if (!fim) return "";
  const ms = fim - Date.now();
  if (ms <= 0) return "Promoção encerrada";

  const totalSeg = Math.floor(ms / 1000);
  const dias = Math.floor(totalSeg / 86400);
  const horas = Math.floor((totalSeg % 86400) / 3600);
  const minutos = Math.floor((totalSeg % 3600) / 60);
  const segundos = totalSeg % 60;

  if (dias > 0) return `Termina em ${dias}d ${horas}h ${minutos}m`;
  if (horas > 0) return `Termina em ${horas}h ${minutos}m ${segundos}s`;
  return `Termina em ${minutos}m ${segundos}s`;
}

function setStoreTab(tab) {
  state.storeTabInitialized = true;
  state.activeStoreTab = tab === "promocoes" ? "promocoes" : "normal";
  const isPromotions = state.activeStoreTab === "promocoes";

  els.normalTab.classList.toggle("is-active", !isPromotions);
  els.promoTab.classList.toggle("is-active", isPromotions);
  els.normalTab.setAttribute("aria-selected", String(!isPromotions));
  els.promoTab.setAttribute("aria-selected", String(isPromotions));
  renderProducts();
}

function showPromoNewsIfNeeded() {
  if (state.promoNewsShown) return;
  state.promoNewsShown = true;

  const promotions = (state.config?.produtos || []).filter((product) => product.promocao);
  if (!promotions.length) return;

  const quantidade = promotions.length;
  els.promoNewsText.textContent = quantidade === 1
    ? "Temos uma promoção disponível agora na loja."
    : `Temos ${quantidade} promoções disponíveis agora na loja.`;
  openModal(els.promoNewsModal);
}

async function beginPurchase(productId) {
  const product = state.config?.produtos?.find((item) => item.id === productId)
    || (state.config?.vendaChave?.id === productId ? state.config.vendaChave : null);
  if (!product) return showToast("Produto não encontrado.");

  if (product.promocao && isPromotionPurchased(product.id)) {
    renderProducts();
    return showToast("Pacote já adquirido. Cada promoção pode ser comprada apenas uma vez.");
  }

  if (product.vendaChave && state.wallet?.acessoComprado) {
    return openAccessModal();
  }

  if (!state.user) {
    sessionStorage.setItem("pendingProduct", productId);
    openModal(els.authModal);
    return;
  }

  if (!state.account?.cadastrado) {
    sessionStorage.setItem("pendingProduct", productId);
    openModal(els.nickModal);
    return;
  }

  if (!state.mp || !state.config.checkoutDisponivel) {
    return showToast("Checkout temporariamente indisponível.");
  }

  state.currentProduct = product;
  els.checkoutTitle.textContent = product.titulo;
  els.checkoutDescription.textContent = product.vendaChave
    ? `Após a aprovação, a chave será gerada para ${state.wallet?.nick || state.account?.conta?.nick || "sua conta"}.`
    : `${formatNumber(product.titulos)} Títulos serão enviados para ${state.wallet?.nick || state.account?.conta?.nick || "sua conta"}.`;
  els.checkoutPrice.textContent = formatMoney(product.valor, product.moeda);
  els.checkoutIcon.src = product.vendaChave ? "/assets/Icone_Game.png" : "/assets/Icone_Titulos.png";
  els.paymentResult.hidden = true;
  els.paymentBrickContainer.hidden = false;
  openModal(els.checkoutModal);

  await renderPaymentBrick();
}

async function renderPaymentBrick() {
  await destroyBrick();
  if (!state.mp || !state.currentProduct) return;

  const bricks = state.mp.bricks();
  state.brickController = await bricks.create("payment", "paymentBrickContainer", {
    initialization: {
      amount: Number(state.currentProduct.valor),
      payer: { email: state.user?.email || "" }
    },
    customization: {
      paymentMethods: {
        creditCard: "all",
        debitCard: "all",
        bankTransfer: ["pix"],
        maxInstallments: 12
      },
      visual: {
        style: { theme: "dark" },
        hideFormTitle: true,
        hidePaymentButton: false
      }
    },
    callbacks: {
      onReady: () => {},
      onSubmit: async ({ selectedPaymentMethod, formData }) => {
        try {
          const result = await processPayment(selectedPaymentMethod, formData);
          await handlePaymentResult(result);
          return Promise.resolve();
        } catch (error) {
          showToast(error.message);
          return Promise.reject(error);
        }
      },
      onError: (error) => {
        console.error(error);
        showToast("O checkout encontrou um erro. Tente novamente.");
      }
    }
  });
}

async function processPayment(_selectedPaymentMethod, formData) {
  const idempotencyKey = cryptoRandomUuid();
  return apiFetch("/api/processar-pagamento", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify({
      produtoId: state.currentProduct.id,
      formData
    })
  });
}

async function handlePaymentResult(data) {
  state.pendingPaymentId = data.pagamentoId || null;
  els.paymentBrickContainer.hidden = true;
  els.paymentResult.hidden = false;

  if (data.aprovado) {
    renderApproved(data);
    await refreshWallet();
    return;
  }

  if (data.pix?.qrCode) {
    renderPixPending(data);
    startPaymentPolling();
    return;
  }

  if (["pending", "in_process"].includes(String(data.status).toLowerCase())) {
    renderPending(data);
    startPaymentPolling();
    return;
  }

  renderRejected(data);
}

function renderApproved(data) {
  if (data.vendaChave) {
    els.paymentResult.innerHTML = `
      <h3>Chave liberada</h3>
      <p>${escapeHtml(data.mensagem || "Pagamento confirmado. Sua chave foi liberada.")}</p>
      <button class="button button--primary" type="button" data-open-access>Ver minha chave</button>
      <button class="button button--ghost" type="button" data-finish-purchase>Fechar</button>`;
    els.paymentResult.querySelector("[data-open-access]")?.addEventListener("click", async () => {
      await closeCheckout();
      await openAccessModal();
    });
    els.paymentResult.querySelector("[data-finish-purchase]")?.addEventListener("click", closeCheckout);
    return;
  }

  els.paymentResult.innerHTML = `
    <h3>Compra aprovada</h3>
    <p>${escapeHtml(data.mensagem || "Pagamento confirmado.")}</p>
    <p><strong>+${formatNumber(data.titulos)} Títulos</strong>${data.saldoTitulos != null ? ` • Novo saldo: ${formatNumber(data.saldoTitulos)}` : ""}</p>
    <button class="button button--primary" type="button" data-finish-purchase>Concluir</button>`;
  els.paymentResult.querySelector("[data-finish-purchase]").addEventListener("click", closeCheckout);
}

function renderPixPending(data) {
  const qrImage = data.pix.qrCodeBase64 ? `data:image/png;base64,${data.pix.qrCodeBase64}` : "";
  els.paymentResult.innerHTML = `
    <h3>PIX gerado</h3>
    <p>${data.vendaChave
      ? "Pague o PIX e mantenha esta janela aberta. Assim que o pagamento for confirmado, sua chave será liberada."
      : "Pague o PIX e mantenha esta janela aberta. Assim que o pagamento for confirmado, os Títulos serão creditados."}</p>
    <div class="pix-box">
      ${qrImage ? `<img src="${qrImage}" alt="QR Code PIX">` : ""}
      <div>
        <textarea class="pix-code" readonly>${escapeHtml(data.pix.qrCode)}</textarea>
        <button class="button button--primary" type="button" data-copy-pix>Copiar PIX</button>
      </div>
    </div>
    <p id="pollStatus">Aguardando pagamento...</p>`;

  els.paymentResult.querySelector("[data-copy-pix]")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(data.pix.qrCode);
    showToast("Código PIX copiado.");
  });
}

function renderPending(data) {
  els.paymentResult.innerHTML = `<h3>Pagamento em análise</h3><p>${escapeHtml(data.mensagem || "Aguardando confirmação.")}</p><p id="pollStatus">Verificando pagamento...</p>`;
}

function renderRejected(data) {
  els.paymentResult.innerHTML = `
    <h3>Pagamento não aprovado</h3>
    <p>${escapeHtml(data.mensagem || "O pagamento não foi aprovado.")}</p>
    <button class="button button--ghost" type="button" data-try-again>Tentar novamente</button>`;
  els.paymentResult.querySelector("[data-try-again]")?.addEventListener("click", async () => {
    els.paymentResult.hidden = true;
    els.paymentBrickContainer.hidden = false;
    await renderPaymentBrick();
  });
}

function startPaymentPolling() {
  stopPaymentPolling();
  if (!state.pendingPaymentId) return;

  let attempts = 0;
  state.paymentPoll = setInterval(async () => {
    attempts += 1;
    if (attempts > 80) {
      stopPaymentPolling();
      const pollStatus = document.getElementById("pollStatus");
      if (pollStatus) pollStatus.textContent = "A confirmação pode demorar. Você pode fechar e consultar sua conta depois.";
      return;
    }

    try {
      const data = await apiFetch(`/api/verificar-pagamento?payment_id=${encodeURIComponent(state.pendingPaymentId)}`);
      const pollStatus = document.getElementById("pollStatus");
      if (pollStatus) pollStatus.textContent = `Status: ${statusLabel(data.status)} • verificado agora`;
      if (data.aprovado) {
        stopPaymentPolling();
        renderApproved(data);
        await refreshWallet();
      } else if (["rejected", "cancelled", "refunded", "charged_back"].includes(String(data.status).toLowerCase())) {
        stopPaymentPolling();
        renderRejected(data);
        await refreshWallet();
      }
    } catch (error) {
      console.warn(error);
    }
  }, 5000);
}

function stopPaymentPolling() {
  if (state.paymentPoll) clearInterval(state.paymentPoll);
  state.paymentPoll = null;
}

async function closeCheckout() {
  stopPaymentPolling();
  state.pendingPaymentId = null;
  state.currentProduct = null;
  if (els.checkoutIcon) els.checkoutIcon.src = "/assets/Icone_Titulos.png";
  await destroyBrick();
  closeModal(els.checkoutModal);
  els.paymentResult.hidden = true;
  els.paymentBrickContainer.hidden = false;
}

async function destroyBrick() {
  if (!state.brickController) return;
  try { await state.brickController.unmount(); } catch {}
  state.brickController = null;
  els.paymentBrickContainer.innerHTML = "";
}

async function apiFetch(url, options = {}) {
  const request = { ...options, headers: { ...(options.headers || {}) } };
  const useAuth = options.auth !== false;
  delete request.auth;

  if (useAuth && state.user) {
    const token = await state.user.getIdToken();
    request.headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, request);
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data.erro || `Erro HTTP ${response.status}`);
  return data;
}

function openModal(modal) {
  modal.hidden = false;
  document.body.classList.add("modal-open");
}

function closeModal(modal) {
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  if ([els.authModal, els.nickModal, els.accountModal, els.checkoutModal, els.promoNewsModal, els.keySaleModal, els.accessModal].every((item) => item.hidden)) {
    document.body.classList.remove("modal-open");
  }
}

function startBackgroundSlideshow() {
  const slides = [...document.querySelectorAll(".background__slide")];
  if (slides.length < 2) return;
  let index = 0;
  setInterval(() => {
    slides[index].classList.remove("is-active");
    index = (index + 1) % slides.length;
    slides[index].classList.add("is-active");
  }, 7000);
}

function renderAvatar(target, url, fallback) {
  if (!target) return;
  if (url) target.innerHTML = `<img src="${escapeHtml(url)}" alt="">`;
  else target.textContent = fallback || "G";
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { els.toast.hidden = true; }, 4200);
}

function formatMoney(value, currency = "BRL") {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(Number(value) || 0);
}

function formatNumber(value) {
  return new Intl.NumberFormat("pt-BR").format(Number(value) || 0);
}

function firstLetter(value) {
  return String(value || "G").trim().charAt(0).toUpperCase() || "G";
}

function statusLabel(status) {
  const s = String(status || "").toLowerCase();
  const labels = {
    approved: "Aprovado",
    pending: "Pendente",
    in_process: "Em análise",
    rejected: "Recusado",
    cancelled: "Cancelado",
    refunded: "Estornado",
    charged_back: "Contestado"
  };
  return labels[s] || "Aguardando";
}

function statusCss(status) {
  const s = String(status || "").toLowerCase();
  if (["pending", "in_process"].includes(s)) return "status-pending";
  if (["refunded", "charged_back"].includes(s)) return "status-refunded";
  if (["rejected", "cancelled"].includes(s)) return "status-rejected";
  return "";
}

function firebaseErrorMessage(error, inicializacao = false) {
  const code = String(error?.code || "");
  if (code.includes("popup-closed")) return "A janela de login foi fechada.";
  if (code.includes("popup-blocked")) return "O navegador bloqueou a janela de login. Libere pop-ups para este site.";
  if (code.includes("unauthorized-domain")) return "Este endereço não está autorizado no Firebase Authentication.";
  if (code.includes("operation-not-allowed")) return "O login com Google não está habilitado no Firebase Authentication.";
  if (code.includes("network")) return "Falha de rede durante o login.";
  if (inicializacao) return "Não foi possível inicializar o login.";
  return "Não foi possível entrar na conta.";
}

function cryptoRandomUuid() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0,4).join("")}-${hex.slice(4,6).join("")}-${hex.slice(6,8).join("")}-${hex.slice(8,10).join("")}-${hex.slice(10).join("")}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Continua automaticamente a compra depois do login/cadastro.
setInterval(() => {
  const productId = sessionStorage.getItem("pendingProduct");
  if (!productId || !state.user || !state.account?.cadastrado || !state.wallet) return;
  sessionStorage.removeItem("pendingProduct");
  beginPurchase(productId);
}, 700);
