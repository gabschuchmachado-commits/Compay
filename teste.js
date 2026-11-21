const appContent = document.querySelector("#app-content");
const searchInput = document.querySelector("#search-input");
const modal = document.querySelector("#app-modal");
const toast = document.querySelector("#toast");
const cartKey = "compay-cart-v3";
const categories = ["Moda e acessórios", "Casa e decoração", "Beleza e cuidados", "Eletrônicos", "Artesanato", "Brinquedos e hobbies", "Livros e papelaria", "Hortifruti", "Mercearia", "Laticínios", "Padaria", "Bebidas", "Outros"];
const fallbackImages = {
  "Moda e acessórios": "https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=700&q=80",
  "Casa e decoração": "https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?auto=format&fit=crop&w=700&q=80",
  "Beleza e cuidados": "https://images.unsplash.com/photo-1596462502278-27bfdc403348?auto=format&fit=crop&w=700&q=80",
  Eletrônicos: "https://images.unsplash.com/photo-1498049794561-7780e7231661?auto=format&fit=crop&w=700&q=80",
  Artesanato: "https://images.unsplash.com/photo-1452860606245-08befc0ff44b?auto=format&fit=crop&w=700&q=80",
  "Brinquedos e hobbies": "https://images.unsplash.com/photo-1558060370-d644479cb6f7?auto=format&fit=crop&w=700&q=80",
  "Livros e papelaria": "https://images.unsplash.com/photo-1507842217343-583bb7270b66?auto=format&fit=crop&w=700&q=80",
  Hortifruti: "https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=700&q=80",
  Mercearia: "https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=700&q=80",
  Laticínios: "https://images.unsplash.com/photo-1486297678162-eb2a19b0a32d?auto=format&fit=crop&w=700&q=80",
  Padaria: "https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&w=700&q=80",
  Bebidas: "https://images.unsplash.com/photo-1600271886742-f049cd451bba?auto=format&fit=crop&w=700&q=80",
  Outros: "https://images.unsplash.com/photo-1472851294608-062f824d29cc?auto=format&fit=crop&w=700&q=80"
};
let user = null;
let csrfToken = null;
let stores = [];
let products = [];
let cart = loadCart();
let currentView = "market";
let currentStoreId = null;
let selectedStoreId = null;
let searchTerm = "";
let selectedCategory = "Todos";
let sortMode = "popular";
let afterAuthentication = null;
let toastTimer;
let marketRequestNumber = 0;

const money = (value) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function loadCart() {
  try {
    const saved = JSON.parse(localStorage.getItem(cartKey) || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved)
      .filter(([, quantity]) => Number.isInteger(quantity) && quantity > 0 && quantity < 100));
  } catch (error) {
    console.warn("Não foi possível carregar a sacola.", error);
    return {};
  }
}

function saveCart() {
  try {
    localStorage.setItem(cartKey, JSON.stringify(cart));
  } catch (error) {
    console.warn("Não foi possível salvar a sacola neste navegador.", error);
  }
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = new Headers(options.headers || {});
  const isAuth = path === "/api/auth/login" || path === "/api/auth/register";
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (method !== "GET" && !isAuth && csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(path, {
    ...options,
    method,
    headers,
    credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("O servidor retornou uma resposta inválida.");
  }
  if (!response.ok) throw new Error(data.error || "Não foi possível concluir a solicitação.");
  return data;
}

function setNav(view) {
  currentView = view;
  document.querySelectorAll(".nav-link").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === (view === "store" ? "stores" : view));
  });
}

function updateAccountButton() {
  const button = document.querySelector("#account-button");
  button.textContent = user ? `Sair · ${user.name}` : "Entrar";
  button.setAttribute("aria-label", user ? `Sair da conta de ${user.name}` : "Entrar ou criar uma conta");
  document.querySelector("#admin-portal-button").hidden = !user || user.role !== "admin";
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function initials(name) {
  return String(name || "").trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
}

function imageFor(value, category) {
  const image = String(value || "").trim();
  try {
    const url = new URL(image, window.location.href);
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  } catch {}
  return fallbackImages[category] || fallbackImages.Outros;
}

function setProducts(nextProducts) {
  products = nextProducts;
}

function storeCard(store) {
  const rating = Number(store.reviewCount) > 0
    ? `★ ${Number(store.averageRating).toFixed(1)} · ${store.reviewCount} ${Number(store.reviewCount) === 1 ? "avaliação" : "avaliações"}`
    : "Nova loja";
  const popularity = Number(store.soldCount) > 0
    ? `${store.soldCount} ${Number(store.soldCount) === 1 ? "produto vendido" : "produtos vendidos"}`
    : "Acabou de chegar";
  return `<article class="store-card">
    <div class="store-cover"><img src="${escapeHtml(imageFor(store.image, store.category))}" alt="" loading="lazy"><span class="store-monogram">${escapeHtml(initials(store.name))}</span></div>
    <div class="store-body">
      <div class="store-meta"><span class="store-category">${escapeHtml(store.category)}</span><span class="store-rating">${escapeHtml(rating)}</span></div>
      <h3>${escapeHtml(store.name)}</h3><p>${escapeHtml(store.description || "Conheça os produtos desta loja.")}</p>
      <div class="store-footer"><span class="store-location">${escapeHtml(popularity)}</span><button class="store-open" data-open-store="${escapeHtml(store.id)}">Visitar loja →</button></div>
    </div>
  </article>`;
}

function productCard(product) {
  const store = stores.find((item) => item.id === product.shopId);
  if (!store) return "";
  const badge = product.oldPrice && Number(product.oldPrice) > Number(product.price)
    ? `<span class="product-badge">OFERTA</span>`
    : "";
  return `<article class="product-card">
    <div class="product-photo"><img src="${escapeHtml(imageFor(product.image, product.category))}" alt="${escapeHtml(product.name)}" loading="lazy">${badge}</div>
    <div class="product-info">
      <a class="product-store" href="#" data-open-store="${escapeHtml(store.id)}">↗ ${escapeHtml(store.name)}</a>
      <h3 class="product-name">${escapeHtml(product.name)}</h3><span class="product-unit">${escapeHtml(product.unit)}</span>
      <div class="price-row"><strong class="product-price">${money(Number(product.price))}</strong>${product.oldPrice ? `<span class="old-price">${money(Number(product.oldPrice))}</span>` : ""}</div>
      <button class="add-button" type="button" data-add="${escapeHtml(product.id)}"><span>+</span> Adicionar</button>
    </div>
  </article>`;
}

function bindShopLinks() {
  appContent.querySelectorAll("[data-open-store]").forEach((button) => button.addEventListener("click", (event) => {
    event.preventDefault();
    showStorefront(button.dataset.openStore);
  }));
}

function bindAddButtons() {
  appContent.querySelectorAll("[data-add]").forEach((button) => button.addEventListener("click", () => addToCart(button.dataset.add)));
}

async function loadMarketData() {
  const [storeResult, productResult] = await Promise.all([
    api("/api/stores"),
    api("/api/products")
  ]);
  return { stores: storeResult.stores, products: productResult.products };
}

async function showMarket() {
  searchTerm = "";
  searchInput.value = "";
  selectedCategory = "Todos";
  currentStoreId = null;
  setNav("market");
  const requestId = ++marketRequestNumber;
  try {
    const data = await loadMarketData();
    if (requestId !== marketRequestNumber) return;
    stores = data.stores;
    setProducts(data.products);
    updateCart();
    renderMarket(data.stores, data.products);
  } catch (error) {
    renderServerError(error);
  }
}

function renderMarket(foundStores, foundProducts) {
  const matchingStores = foundStores.filter((store) =>
    `${store.name} ${store.category} ${store.description}`.toLocaleLowerCase("pt-BR").includes(searchTerm.toLocaleLowerCase("pt-BR"))
  );
  const matchingStoreIds = new Set(matchingStores.map((store) => store.id));
  const matchingProducts = foundProducts.filter((product) => {
    if (!searchTerm) return true;
    const text = `${product.name} ${product.category} ${product.unit} ${product.description}`.toLocaleLowerCase("pt-BR");
    return matchingStoreIds.has(product.shopId) || text.includes(searchTerm.toLocaleLowerCase("pt-BR"));
  });
  const productResultCount = matchingProducts.filter((product) =>
    selectedCategory === "Todos" || product.category === selectedCategory
  ).length;
  const categoriesInUse = ["Todos", ...new Set(foundProducts.map((product) => product.category))];
  const filteredProducts = matchingProducts.filter((product) =>
    selectedCategory === "Todos" || product.category === selectedCategory
  );
  const sortedProducts = [...filteredProducts];
  if (sortMode === "price-asc") sortedProducts.sort((a, b) => Number(a.price) - Number(b.price));
  if (sortMode === "price-desc") sortedProducts.sort((a, b) => Number(b.price) - Number(a.price));
  if (sortMode === "name") sortedProducts.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  appContent.innerHTML = `
    ${!searchTerm ? `<section class="hero-wrap"><div class="hero"><div class="hero-copy">
      <span class="hero-kicker"><span>✳</span> MARKETPLACE DA SUA REGIÃO</span>
      <h1>Compre de quem<br>vende pertinho<span>.</span></h1>
      <p>Descubra lojas independentes, compare produtos e encontre seus novos favoritos em um só lugar.</p>
      <a class="hero-cta" href="#lojas">Ver lojas mais compradas <span>→</span></a>
      <div class="hero-note">Sua próxima loja favorita pode estar logo ali.</div>
    </div><div class="hero-badge"><strong>${foundStores.length}</strong><small>LOJAS<br>NO COM PAY</small></div></div>
    <div class="trust-row">
      <div class="trust-item"><span class="trust-icon">🏪</span><span><strong>Negócios independentes</strong><small>Cada vendedor monta sua vitrine</small></span></div>
      <div class="trust-item"><span class="trust-icon">🔎</span><span><strong>Descubra e compare</strong><small>Produtos de diferentes lojas</small></span></div>
      <div class="trust-item"><span class="trust-icon">⭐</span><span><strong>Avaliações de clientes</strong><small>Opiniões após uma compra</small></span></div>
    </div></section>` : ""}
    <section class="page-width" id="lojas">
      <div class="section-heading"><div><span class="section-eyebrow">${searchTerm ? "BUSCA NO COM PAY" : "ESCOLHAS DA COMUNIDADE"}</span><h2>${searchTerm ? `Resultados para “${escapeHtml(searchTerm)}”` : "Lojas mais compradas"}</h2><p>${searchTerm ? `${matchingStores.length} lojas e ${productResultCount} produtos encontrados.` : "As vitrines com mais produtos comprados pelos clientes."}</p></div>
      ${!searchTerm && foundStores.length ? `<button class="text-button" id="all-stores-button">Ver todas as lojas →</button>` : ""}</div>
      ${matchingStores.length ? `<div class="store-grid">${matchingStores.slice(0, searchTerm ? matchingStores.length : 3).map(storeCard).join("")}</div>` : `<div class="empty-products"><strong>${searchTerm ? "Nenhuma loja encontrada" : "O Com Pay está começando por aqui"}</strong><p>${searchTerm ? "Tente outra busca." : "Ainda não há lojas cadastradas. Seja a primeira pessoa a abrir uma vitrine."}</p>${!searchTerm ? `<button class="text-button" id="first-store-button">Cadastrar minha loja →</button>` : ""}</div>`}
    </section>
    <section class="page-width" id="produtos">
      <div class="section-heading"><div><span class="section-eyebrow">VITRINE DO MARKETPLACE</span><h2>${searchTerm ? "Produtos encontrados" : "Produtos das lojas"}</h2><p>Veja de qual loja vem cada produto e adicione à sua sacola.</p></div></div>
      <div class="product-toolbar"><div class="filter-row">${categoriesInUse.map((category) => `<button class="filter-chip ${selectedCategory === category ? "active" : ""}" data-filter-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join("")}</div>
        <label class="sort-control">Ordenar <select id="sort-select"><option value="popular" ${sortMode === "popular" ? "selected" : ""}>Mais comprados</option><option value="price-asc" ${sortMode === "price-asc" ? "selected" : ""}>Menor preço</option><option value="price-desc" ${sortMode === "price-desc" ? "selected" : ""}>Maior preço</option><option value="name" ${sortMode === "name" ? "selected" : ""}>Nome A–Z</option></select></label>
      </div>
      ${sortedProducts.length ? `<div class="product-grid">${sortedProducts.map(productCard).join("")}</div>` : `<div class="empty-products"><strong>${foundProducts.length ? "Nenhum produto nesta categoria" : "Ainda não há produtos anunciados"}</strong><p>${foundProducts.length ? "Escolha outra categoria." : "Quando uma loja publicar seus produtos, eles aparecerão nesta vitrine."}</p></div>`}
      <div class="notice">Lojas e anúncios são publicados por seus vendedores após aprovação. Para avaliar uma loja, faça um pedido e deixe sua opinião na página dela.</div>
    </section>`;

  appContent.querySelector("#all-stores-button")?.addEventListener("click", showStores);
  appContent.querySelector("#first-store-button")?.addEventListener("click", showSellerPortal);
  appContent.querySelectorAll("[data-filter-category]").forEach((button) => button.addEventListener("click", () => {
    selectedCategory = button.dataset.filterCategory;
    renderMarket(foundStores, foundProducts);
  }));
  appContent.querySelector("#sort-select")?.addEventListener("change", (event) => {
    sortMode = event.target.value;
    renderMarket(foundStores, foundProducts);
  });
  bindShopLinks();
  bindAddButtons();
}

async function showStores() {
  searchTerm = "";
  searchInput.value = "";
  selectedCategory = "Todos";
  setNav("stores");
  const requestId = ++marketRequestNumber;
  try {
    const [storeResult, productResult] = await Promise.all([api("/api/stores"), api("/api/products")]);
    if (requestId !== marketRequestNumber) return;
    stores = storeResult.stores;
    products = productResult.products;
    await updateCart();
    appContent.innerHTML = `
      <header class="page-heading"><span class="eyebrow">MARKETPLACE COM PAY</span><h1>Todas as lojas</h1><p>Explore as vitrines dos vendedores. A lista começa vazia e cresce conforme as lojas são aprovadas.</p></header>
      <section class="page-width">${stores.length ? `<div class="store-grid">${stores.map(storeCard).join("")}</div>` : `<div class="empty-products"><strong>Nenhuma loja cadastrada ainda</strong><p>Cadastre a primeira loja e ela aparecerá aqui depois da aprovação.</p><button class="text-button" id="join-marketplace">Abrir uma loja →</button></div>`}</section>`;
    appContent.querySelector("#join-marketplace")?.addEventListener("click", showSellerPortal);
    bindShopLinks();
  } catch (error) {
    renderServerError(error);
  }
}

async function showStorefront(storeId) {
  setNav("store");
  currentStoreId = storeId;
  try {
    const [storeResult, productResult, reviewResult] = await Promise.all([
      api(`/api/stores/${encodeURIComponent(storeId)}`),
      api(`/api/stores/${encodeURIComponent(storeId)}/products`),
      api(`/api/stores/${encodeURIComponent(storeId)}/reviews`)
    ]);
    const store = storeResult.store;
    stores = [store, ...stores.filter((item) => item.id !== store.id)];
    products = [...productResult.products, ...products.filter((item) => item.shopId !== store.id)];
    updateCart();
    const reviewSummary = store.reviewCount
      ? `★ ${Number(store.averageRating).toFixed(1)} · ${store.reviewCount} ${store.reviewCount === 1 ? "avaliação" : "avaliações"}`
      : "Ainda sem avaliações";
    appContent.innerHTML = `
      <header class="store-detail-head page-width"><span class="store-detail-logo">${escapeHtml(initials(store.name))}</span>
        <div><span class="section-eyebrow">${escapeHtml(store.category)}</span><h1>${escapeHtml(store.name)}</h1><p>${escapeHtml(store.description || "Conheça os produtos desta loja.")}${store.location ? ` · ${escapeHtml(store.location)}` : ""}</p></div>
        <span class="detail-badge">${escapeHtml(reviewSummary)}</span>
      </header>
      <section class="store-detail-content"><button class="back-button" id="back-to-stores">← Voltar às lojas</button>
        <div class="section-heading"><div><span class="section-eyebrow">VITRINE DA LOJA</span><h2>Produtos de ${escapeHtml(store.name)}</h2><p>${productResult.products.length} ${productResult.products.length === 1 ? "produto disponível" : "produtos disponíveis"}.</p></div></div>
        ${productResult.products.length ? `<div class="product-grid">${productResult.products.map(productCard).join("")}</div>` : `<div class="empty-products"><strong>Esta loja ainda não anunciou produtos</strong><p>Volte mais tarde para conferir as novidades.</p></div>`}
        <section class="reviews-section"><div class="section-heading"><div><span class="section-eyebrow">OPINIÕES VERIFICADAS</span><h2>Avaliações da loja</h2><p>Somente clientes que fizeram um pedido podem avaliar.</p></div></div>
          ${renderReviews(reviewResult)}
        </section>
      </section>`;
    appContent.querySelector("#back-to-stores").addEventListener("click", showStores);
    appContent.querySelector("#review-form")?.addEventListener("submit", submitReview);
    bindShopLinks();
    bindAddButtons();
  } catch (error) {
    renderServerError(error);
  }
}

function renderReviews(result) {
  const reviewList = result.reviews.length
    ? `<div class="reviews-list">${result.reviews.map((review) => `<article class="review-card"><div class="review-head"><strong>${escapeHtml(review.author)}</strong><span>${"★".repeat(review.rating)}${"☆".repeat(5 - review.rating)}</span></div><p>${escapeHtml(review.comment || "Cliente avaliou esta loja.")}</p><small>${new Date(review.createdAt).toLocaleDateString("pt-BR")}</small></article>`).join("")}</div>`
    : `<div class="empty-panel">Esta loja ainda não recebeu avaliações.</div>`;
  let reviewForm = "";
  if (result.canReview) {
    const currentRating = result.myReview?.rating || 5;
    const currentComment = result.myReview?.comment || "";
    reviewForm = `<form class="review-form" id="review-form"><strong>${result.myReview ? "Atualize sua avaliação" : "Você já comprou nesta loja"} </strong>
      <label for="review-rating">Sua nota</label><select id="review-rating" name="rating">${[5, 4, 3, 2, 1].map((rating) => `<option value="${rating}" ${Number(currentRating) === rating ? "selected" : ""}>${"★".repeat(rating)} (${rating}/5)</option>`).join("")}</select>
      <label for="review-comment">Comentário opcional</label><textarea id="review-comment" name="comment" maxlength="500" placeholder="Conte como foi sua experiência">${escapeHtml(currentComment)}</textarea>
      <button class="form-submit" type="submit">Publicar avaliação</button></form>`;
  } else if (result.loggedIn) {
    reviewForm = `<div class="notice">Faça um pedido nesta loja para liberar uma avaliação verificada.</div>`;
  } else {
    reviewForm = `<div class="notice">Entre na sua conta e faça um pedido para avaliar esta loja.</div>`;
  }
  return `${reviewForm}${reviewList}`;
}

async function submitReview(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api(`/api/stores/${encodeURIComponent(currentStoreId)}/reviews`, {
      method: "POST",
      body: { rating: Number(form.get("rating")), comment: String(form.get("comment") || "") }
    });
    showToast("Obrigado! Sua avaliação foi publicada.");
    await showStorefront(currentStoreId);
  } catch (error) {
    showToast(error.message);
  }
}

function showModal() {
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  document.querySelector("#modal-backdrop").classList.add("show");
  document.body.classList.add("locked");
  modal.querySelector("button, input, select")?.focus();
}

function closeModal() {
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  document.querySelector("#modal-backdrop").classList.remove("show");
  document.body.classList.remove("locked");
  afterAuthentication = null;
}

function showAuthModal(mode = "login", message = "") {
  modal.innerHTML = `
    <div class="modal-heading"><div><span class="section-eyebrow">CONTA COM PAY</span><h2 id="modal-title">${mode === "register" ? "Criar sua conta" : "Entrar no Com Pay"}</h2><p>${escapeHtml(message || "Compre, acompanhe pedidos e abra sua própria loja.")}</p></div><button class="modal-close" data-close-modal aria-label="Fechar">×</button></div>
    <div class="auth-tabs"><button type="button" class="${mode === "login" ? "active" : ""}" data-auth-mode="login">Entrar</button><button type="button" class="${mode === "register" ? "active" : ""}" data-auth-mode="register">Criar conta</button></div>
    <form class="form-grid" id="auth-form">
      ${mode === "register" ? `<div class="form-field"><label for="auth-name">Seu nome</label><input id="auth-name" name="name" maxlength="80" autocomplete="name" required></div>` : ""}
      <div class="form-field"><label for="auth-email">E-mail</label><input id="auth-email" name="email" type="email" maxlength="254" autocomplete="email" required></div>
      <div class="form-field"><label for="auth-password">Senha</label><input id="auth-password" name="password" type="password" minlength="12" maxlength="256" autocomplete="${mode === "register" ? "new-password" : "current-password"}" required>${mode === "register" ? `<span class="form-hint">Use pelo menos 12 caracteres.</span>` : ""}</div>
      <div class="form-error" id="auth-error"></div>
      <button class="form-submit" type="submit">${mode === "register" ? "Criar conta" : "Entrar"}</button>
    </form>
    <div class="notice">A conta é protegida pelo servidor. O papel de administrador não pode ser escolhido no cadastro público.</div>`;
  showModal();
  modal.querySelector("[data-close-modal]").addEventListener("click", closeModal);
  modal.querySelectorAll("[data-auth-mode]").forEach((button) => button.addEventListener("click", () => showAuthModal(button.dataset.authMode, message)));
  modal.querySelector("#auth-form").addEventListener("submit", submitAuth);
}

async function submitAuth(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const isRegister = form.has("name");
  const error = modal.querySelector("#auth-error");
  const button = event.currentTarget.querySelector(".form-submit");
  button.disabled = true;
  try {
    const result = await api(`/api/auth/${isRegister ? "register" : "login"}`, {
      method: "POST",
      body: {
        ...(isRegister ? { name: String(form.get("name") || "").trim() } : {}),
        email: String(form.get("email") || "").trim(),
        password: String(form.get("password") || "")
      }
    });
    user = result.user;
    csrfToken = result.csrfToken;
    updateAccountButton();
    const resume = afterAuthentication;
    closeModal();
    showToast(`Bem-vindo${user.name ? `, ${user.name}` : ""}!`);
    if (resume) await resume();
    else if (currentView === "seller") await showSellerDashboard();
  } catch (error) {
    errorElement(error, "auth-error");
    button.disabled = false;
  }
}

function errorElement(error, id) {
  const element = modal.querySelector(`#${id}`);
  if (!element) {
    showToast(error.message);
    return;
  }
  element.textContent = error.message;
  element.classList.add("show");
}

async function showSellerPortal() {
  if (!user) {
    afterAuthentication = () => showSellerDashboard();
    showAuthModal("login", "Entre ou crie uma conta para cadastrar e gerenciar sua loja.");
    return;
  }
  await showSellerDashboard();
}

async function showSellerDashboard() {
  setNav("seller");
  try {
    const result = await api("/api/seller/stores");
    const myStores = result.stores;
    if (!myStores.length) {
      selectedStoreId = null;
      renderNewStoreForm();
      return;
    }
    if (!myStores.some((store) => store.id === selectedStoreId)) selectedStoreId = myStores[0].id;
    const store = myStores.find((item) => item.id === selectedStoreId);
    const [productResult, orderResult] = await Promise.all([
      api(`/api/stores/${encodeURIComponent(store.id)}/products`),
      api(`/api/stores/${encodeURIComponent(store.id)}/orders`)
    ]);
    const storeProducts = productResult.products;
    const storeOrders = orderResult.orders;
    const sales = storeOrders.filter((order) => order.status !== "Cancelado").reduce((sum, order) => sum + Number(order.total), 0);
    appContent.innerHTML = `
      <section class="dashboard"><div class="dashboard-top"><div><span class="section-eyebrow">PAINEL DO LOJISTA</span><h1>Olá, ${escapeHtml(user.name)} 👋</h1><p>Gerencie seus anúncios, sua loja e os pedidos recebidos.</p></div><div class="dashboard-actions"><button class="button-secondary" id="new-store-button">+ Nova loja</button>${store.approved ? `<button class="button-secondary" id="view-my-store">Ver minha loja ↗</button>` : ""}</div></div>
        <div class="store-switch-row"><label for="managed-store">Minha loja</label><select id="managed-store">${myStores.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === store.id ? "selected" : ""}>${escapeHtml(item.name)}${item.approved ? "" : " · aguardando aprovação"}</option>`).join("")}</select><span class="status-pill ${store.approved ? "approved" : ""}">${store.approved ? "Publicada" : "Aguardando aprovação"}</span></div>
        ${!store.approved ? `<div class="seller-notice">Sua loja está aguardando aprovação administrativa. Você pode preparar os anúncios; a vitrine ficará pública depois da aprovação.</div>` : ""}
        <div class="stat-grid"><div class="stat-card"><span>Anúncios ativos</span><strong>${storeProducts.length}</strong></div><div class="stat-card"><span>Pedidos recebidos</span><strong>${storeOrders.length}</strong></div><div class="stat-card"><span>Vendas registradas</span><strong>${money(sales)}</strong></div></div>
        <div class="dashboard-grid">
          <section class="panel"><h2>Adicionar anúncio</h2><p>Cadastre o que sua loja vende. O anúncio será associado somente a esta loja.</p>
            <form class="form-grid" id="add-product-form">
              <div class="form-field"><label for="product-name">Nome do produto</label><input id="product-name" name="name" maxlength="80" required placeholder="Ex.: Mel artesanal"></div>
              <div class="form-field"><label for="product-category">Categoria</label><select id="product-category" name="category">${categories.map((item) => `<option ${item === store.category ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select></div>
              <div class="form-field"><label for="product-unit">Unidade ou tamanho</label><input id="product-unit" name="unit" maxlength="40" required placeholder="Ex.: pote 300g"></div>
              <div class="form-field"><label for="product-price">Preço (R$)</label><input id="product-price" name="price" type="number" min="0.01" max="999999" step="0.01" required placeholder="0,00"></div>
              <div class="form-field"><label for="product-old-price">Preço anterior (opcional)</label><input id="product-old-price" name="oldPrice" type="number" min="0.01" max="999999" step="0.01" placeholder="0,00"></div>
              <div class="form-field"><label for="product-image">Link da foto (opcional)</label><input id="product-image" name="image" type="url" maxlength="1000" placeholder="https://..."></div>
              <div class="form-field"><label for="product-description">Descrição (opcional)</label><textarea id="product-description" name="description" maxlength="300" placeholder="Descreva seu produto"></textarea></div>
              <div class="form-error" id="product-error"></div><button class="form-submit" type="submit">Publicar anúncio</button>
            </form>
          </section>
          <div class="seller-right-column">
            <section class="panel"><h2>Anúncios desta loja</h2><p>${storeProducts.length} ${storeProducts.length === 1 ? "produto publicado" : "produtos publicados"}.</p>
              ${storeProducts.length ? `<div class="manage-list">${storeProducts.map((product) => `<div class="manage-item"><span class="manage-thumb"><img src="${escapeHtml(imageFor(product.image, product.category))}" alt="" loading="lazy"></span><span class="manage-description"><strong>${escapeHtml(product.name)}</strong><small>${money(Number(product.price))} · ${escapeHtml(product.unit)}</small></span><button class="delete-button" data-delete-product="${escapeHtml(product.id)}">Remover</button></div>`).join("")}</div>` : `<div class="empty-panel">Nenhum anúncio ainda. Cadastre o primeiro no formulário.</div>`}
            </section>
            <section class="panel orders-panel"><h2>Pedidos da loja</h2><p>Os pedidos aparecem somente para você e para o administrador.</p>
              ${storeOrders.length ? `<div class="orders-list">${storeOrders.map(renderOrder).join("")}</div>` : `<div class="empty-panel">Nenhum pedido recebido ainda.</div>`}
            </section>
            <section class="panel"><h2>Configurações da loja</h2><p>Atualize as informações que os clientes veem.</p>
              <form class="form-grid" id="edit-store-form">
                <div class="form-field"><label for="edit-store-name">Nome da loja</label><input id="edit-store-name" name="name" maxlength="60" required value="${escapeHtml(store.name)}"></div>
                <div class="form-field"><label for="edit-store-category">Categoria principal</label><select id="edit-store-category" name="category">${categories.map((item) => `<option ${store.category === item ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select></div>
                <div class="form-field"><label for="edit-store-description">Descrição</label><textarea id="edit-store-description" name="description" maxlength="300">${escapeHtml(store.description)}</textarea></div>
                <div class="form-field"><label for="edit-store-location">Localização exibida</label><input id="edit-store-location" name="location" maxlength="100" value="${escapeHtml(store.location)}"></div>
                <button class="button-secondary" type="submit">Salvar informações</button>
              </form>
            </section>
          </div>
        </div>
      </section>`;
    appContent.querySelector("#managed-store").addEventListener("change", (event) => {
      selectedStoreId = event.target.value;
      showSellerDashboard();
    });
    appContent.querySelector("#new-store-button").addEventListener("click", renderNewStoreForm);
    appContent.querySelector("#view-my-store")?.addEventListener("click", () => showStorefront(store.id));
    appContent.querySelector("#add-product-form").addEventListener("submit", addProduct);
    appContent.querySelector("#edit-store-form").addEventListener("submit", editStore);
    appContent.querySelectorAll("[data-delete-product]").forEach((button) => button.addEventListener("click", () => deleteProduct(button.dataset.deleteProduct)));
    appContent.querySelectorAll("[data-order-status]").forEach((select) => select.addEventListener("change", () => changeOrderStatus(select.dataset.orderStatus, select.value)));
  } catch (error) {
    renderServerError(error);
  }
}

function renderNewStoreForm() {
  setNav("seller");
  appContent.innerHTML = `
    <section class="dashboard"><div class="dashboard-top"><div><span class="section-eyebrow">COMECE A VENDER</span><h1>Abra sua loja no Com Pay</h1><p>Crie sua vitrine, publique anúncios e acompanhe os pedidos dos clientes.</p></div><button class="button-secondary" id="seller-back">Voltar ao painel</button></div>
      <div class="seller-notice">A loja começa pendente. O administrador precisa aprová-la antes que os produtos apareçam publicamente.</div>
      <section class="panel create-store-panel"><form class="form-grid" id="new-store-form">
        <div class="form-field"><label for="new-store-name">Nome da loja</label><input id="new-store-name" name="name" maxlength="60" required placeholder="Ex.: Ateliê da Vila"></div>
        <div class="form-field"><label for="new-store-category">Categoria principal</label><select id="new-store-category" name="category">${categories.map((item) => `<option>${escapeHtml(item)}</option>`).join("")}</select></div>
        <div class="form-field"><label for="new-store-description">Apresente sua loja</label><textarea id="new-store-description" name="description" maxlength="300" placeholder="O que você vende?"></textarea></div>
        <div class="form-field"><label for="new-store-location">Localização (opcional)</label><input id="new-store-location" name="location" maxlength="100" placeholder="Ex.: Centro, São Paulo"></div>
        <div class="form-field"><label for="new-store-image">Foto de capa (link opcional)</label><input id="new-store-image" name="image" type="url" maxlength="1000" placeholder="https://..."></div>
        <div class="form-error" id="store-error"></div><button class="form-submit" type="submit">Enviar loja para aprovação →</button>
      </form></section>
    </section>`;
  appContent.querySelector("#seller-back").addEventListener("click", showSellerDashboard);
  appContent.querySelector("#new-store-form").addEventListener("submit", createStore);
}

async function createStore(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const button = event.currentTarget.querySelector(".form-submit");
  button.disabled = true;
  try {
    const result = await api("/api/stores", {
      method: "POST",
      body: {
        name: String(form.get("name") || "").trim(),
        category: String(form.get("category") || ""),
        description: String(form.get("description") || "").trim(),
        location: String(form.get("location") || "").trim(),
        image: String(form.get("image") || "").trim()
      }
    });
    selectedStoreId = result.store.id;
    showToast("Loja enviada ao administrador para aprovação.");
    await showSellerDashboard();
  } catch (error) {
    errorElement(error, "store-error");
    button.disabled = false;
  }
}

async function editStore(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api(`/api/stores/${encodeURIComponent(selectedStoreId)}`, {
      method: "PATCH",
      body: {
        name: String(form.get("name") || "").trim(),
        category: String(form.get("category") || ""),
        description: String(form.get("description") || "").trim(),
        location: String(form.get("location") || "").trim()
      }
    });
    showToast("Informações da loja atualizadas.");
    await showSellerDashboard();
  } catch (error) {
    showToast(error.message);
  }
}

async function addProduct(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const button = event.currentTarget.querySelector(".form-submit");
  button.disabled = true;
  try {
    await api(`/api/stores/${encodeURIComponent(selectedStoreId)}/products`, {
      method: "POST",
      body: {
        name: String(form.get("name") || "").trim(),
        category: String(form.get("category") || ""),
        unit: String(form.get("unit") || "").trim(),
        price: Number(form.get("price")),
        oldPrice: String(form.get("oldPrice") || "").trim() || null,
        image: String(form.get("image") || "").trim(),
        description: String(form.get("description") || "").trim()
      }
    });
    showToast("Anúncio publicado na sua loja.");
    await showSellerDashboard();
  } catch (error) {
    errorElement(error, "product-error");
    button.disabled = false;
  }
}

async function deleteProduct(productId) {
  try {
    await api(`/api/stores/${encodeURIComponent(selectedStoreId)}/products/${encodeURIComponent(productId)}`, { method: "DELETE" });
    cart[productId] = undefined;
    delete cart[productId];
    saveCart();
    showToast("Anúncio removido.");
    await showSellerDashboard();
    await updateCart();
  } catch (error) {
    showToast(error.message);
  }
}

async function changeOrderStatus(orderId, status) {
  try {
    await api(`/api/orders/${encodeURIComponent(orderId)}`, { method: "PATCH", body: { status } });
    showToast("Status do pedido atualizado.");
  } catch (error) {
    showToast(error.message);
    await showSellerDashboard();
  }
}

function renderOrder(order) {
  const statuses = ["Recebido", "Em preparo", "Pronto para retirada", "Concluído", "Cancelado"];
  return `<article class="order-card"><div class="order-head"><strong>Pedido #${escapeHtml(order.id.slice(-6))} · ${escapeHtml(order.buyerName)}</strong><small>${new Date(order.createdAt).toLocaleString("pt-BR")}</small></div>
    <p>${order.items.map((item) => `${escapeHtml(item.name)} × ${item.quantity}`).join(" · ")}<br><strong>Total: ${money(Number(order.total))}</strong></p>
    <label class="form-hint">Status <select class="order-status" data-order-status="${escapeHtml(order.id)}">${statuses.map((status) => `<option ${status === order.status ? "selected" : ""}>${status}</option>`).join("")}</select></label>
  </article>`;
}

async function showAdminPanel() {
  if (!user || user.role !== "admin") {
    showToast("Acesso restrito ao administrador.");
    return;
  }
  setNav("admin");
  try {
    const result = await api("/api/admin/stores");
    const allStores = result.stores;
    const pending = allStores.filter((store) => !store.approved).length;
    const approved = allStores.filter((store) => store.approved).length;
    appContent.innerHTML = `
      <section class="dashboard"><div class="dashboard-top"><div><span class="section-eyebrow">ADMINISTRAÇÃO COM PAY</span><h1>Painel administrativo</h1><p>Somente sua conta de administrador pode moderar lojas.</p></div><button class="button-secondary" id="admin-market">Voltar ao marketplace</button></div>
        <div class="stat-grid"><div class="stat-card"><span>Total de lojas</span><strong>${allStores.length}</strong></div><div class="stat-card"><span>Lojas aprovadas</span><strong>${approved}</strong></div><div class="stat-card"><span>Aguardando revisão</span><strong>${pending}</strong></div></div>
        <section class="panel"><h2>Lojas cadastradas</h2><p>Aprove, suspenda ou remova qualquer loja. Remover também exclui anúncios, pedidos e avaliações associados.</p>
          ${allStores.length ? allStores.map((store) => `<div class="admin-shop-row"><span class="admin-monogram">${escapeHtml(initials(store.name))}</span><span class="admin-shop-info"><strong>${escapeHtml(store.name)}</strong><small>${escapeHtml(store.category)} · ${escapeHtml(store.ownerName)} · ${escapeHtml(store.reviewCount)} avaliação(ões)</small></span><span class="status-pill ${store.approved ? "approved" : ""}">${store.approved ? "Publicada" : "Pendente"}</span><span class="admin-actions">${store.approved ? `<button class="approve-button" data-store-visibility="false" data-store-id="${escapeHtml(store.id)}">Suspender</button>` : `<button class="approve-button" data-store-visibility="true" data-store-id="${escapeHtml(store.id)}">Aprovar</button>`}<button class="remove-shop-button" data-delete-store="${escapeHtml(store.id)}">Excluir</button></span></div>`).join("") : `<div class="empty-panel">Nenhuma loja cadastrada. Os cadastros feitos pelos usuários aparecerão aqui para aprovação.</div>`}
        </section>
      </section>`;
    appContent.querySelector("#admin-market").addEventListener("click", showMarket);
    appContent.querySelectorAll("[data-store-visibility]").forEach((button) => button.addEventListener("click", () => moderateStore(button.dataset.storeId, button.dataset.storeVisibility === "true")));
    appContent.querySelectorAll("[data-delete-store]").forEach((button) => button.addEventListener("click", () => deleteStore(button.dataset.deleteStore)));
  } catch (error) {
    renderServerError(error);
  }
}

async function moderateStore(storeId, approved) {
  try {
    await api(`/api/admin/stores/${encodeURIComponent(storeId)}`, { method: "PATCH", body: { approved } });
    const [storeResult, productResult] = await Promise.all([api("/api/stores"), api("/api/products")]);
    stores = storeResult.stores;
    products = productResult.products;
    await updateCart();
    showToast(approved ? "Loja aprovada e publicada." : "Loja suspensa.");
    await showAdminPanel();
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteStore(storeId) {
  if (!window.confirm("Excluir esta loja e todos os anúncios, pedidos e avaliações associados?")) return;
  try {
    await api(`/api/admin/stores/${encodeURIComponent(storeId)}`, { method: "DELETE" });
    const removedProductIds = products.filter((product) => product.shopId === storeId).map((product) => product.id);
    stores = stores.filter((store) => store.id !== storeId);
    products = products.filter((product) => product.shopId !== storeId);
    removedProductIds.forEach((id) => delete cart[id]);
    saveCart();
    await updateCart();
    showToast("Loja e dados associados excluídos.");
    await showAdminPanel();
  } catch (error) {
    showToast(error.message);
  }
}

function loadCartProducts() {
  return products.filter((product) => cart[product.id] > 0 && stores.some((store) => store.id === product.shopId));
}

async function updateCart() {
  const items = loadCartProducts();
  const validIds = new Set(items.map((product) => product.id));
  let changed = false;
  for (const id of Object.keys(cart)) {
    if (!validIds.has(id)) {
      delete cart[id];
      changed = true;
    }
  }
  if (changed) saveCart();
  const count = Object.values(cart).reduce((sum, quantity) => sum + quantity, 0);
  const subtotal = items.reduce((sum, product) => sum + Number(product.price) * cart[product.id], 0);
  const storeIds = new Set(items.map((product) => product.shopId));
  document.querySelector("#cart-count").textContent = count > 99 ? "99+" : String(count);
  document.querySelector("#drawer-count").textContent = `(${count})`;
  document.querySelector("#cart-total-label").textContent = money(subtotal);
  document.querySelector("#subtotal-value").textContent = money(subtotal);
  document.querySelector("#store-count-value").textContent = storeIds.size;
  document.querySelector("#total-value").textContent = money(subtotal);
  document.querySelector("#cart-empty").classList.toggle("show", count === 0);
  document.querySelector("#cart-summary").classList.toggle("hidden", count === 0);
  document.querySelector("#cart-items").hidden = count === 0;
  let lastStoreId = null;
  document.querySelector("#cart-items").innerHTML = items.map((product) => {
    const store = stores.find((item) => item.id === product.shopId);
    const heading = lastStoreId === product.shopId ? "" : `<div class="cart-store-title">${escapeHtml(store.name)}</div>`;
    lastStoreId = product.shopId;
    return `${heading}<div class="cart-item"><img src="${escapeHtml(imageFor(product.image, product.category))}" alt=""><div class="cart-item-info"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.unit)}</small><div class="cart-item-price">${money(Number(product.price) * cart[product.id])}</div></div><div class="quantity-control" aria-label="Quantidade de ${escapeHtml(product.name)}"><button type="button" data-quantity="-1" data-id="${escapeHtml(product.id)}" aria-label="Diminuir quantidade">−</button><span>${cart[product.id]}</span><button type="button" data-quantity="1" data-id="${escapeHtml(product.id)}" aria-label="Aumentar quantidade">+</button></div></div>`;
  }).join("");
  document.querySelectorAll("[data-quantity]").forEach((button) => button.addEventListener("click", () => changeQuantity(button.dataset.id, Number(button.dataset.quantity))));
}

function addToCart(productId) {
  const product = products.find((item) => item.id === productId);
  const store = product && stores.find((item) => item.id === product.shopId);
  if (!product || !store) {
    showToast("Este anúncio não está mais disponível.");
    return;
  }
  cart[productId] = Math.min(99, (cart[productId] || 0) + 1);
  saveCart();
  updateCart();
  showToast(`${product.name} adicionado · ${store.name}`);
}

function changeQuantity(productId, amount) {
  cart[productId] = (cart[productId] || 0) + amount;
  if (cart[productId] <= 0) delete cart[productId];
  saveCart();
  updateCart();
}

function openCart() {
  document.querySelector("#cart-drawer").classList.add("open");
  document.querySelector("#cart-drawer").setAttribute("aria-hidden", "false");
  document.querySelector("#cart-backdrop").classList.add("show");
  document.body.classList.add("locked");
  document.querySelector("#close-cart").focus();
}

function closeCart() {
  document.querySelector("#cart-drawer").classList.remove("open");
  document.querySelector("#cart-drawer").setAttribute("aria-hidden", "true");
  document.querySelector("#cart-backdrop").classList.remove("show");
  document.body.classList.remove("locked");
}

async function checkout() {
  const items = loadCartProducts().map((product) => ({ productId: product.id, quantity: cart[product.id] }));
  if (!items.length) {
    showToast("Sua sacola está vazia.");
    return;
  }
  if (!user) {
    closeCart();
    afterAuthentication = checkout;
    showAuthModal("login", "Entre para confirmar seu pedido. Sua sacola será mantida.");
    return;
  }
  try {
    const result = await api("/api/orders", { method: "POST", body: { items } });
    cart = {};
    saveCart();
    await updateCart();
    closeCart();
    showToast(`${result.orders.length} pedido(s) criado(s), separado(s) por loja.`);
    if (currentView === "seller") await showSellerDashboard();
    if (currentView === "admin") await showAdminPanel();
    if (currentView === "store" && currentStoreId) await showStorefront(currentStoreId);
  } catch (error) {
    showToast(error.message);
  }
}

async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST", body: {} });
  } catch (error) {
    showToast(error.message);
    return;
  }
  user = null;
  csrfToken = null;
  updateAccountButton();
  showToast("Você saiu da sua conta.");
  if (currentView === "admin" || currentView === "seller") showMarket();
  else if (currentView === "store" && currentStoreId) showStorefront(currentStoreId);
}

function renderServerError(error) {
  appContent.innerHTML = `<section class="page-heading"><span class="eyebrow">COM PAY</span><h1>Não foi possível conectar</h1><p>${escapeHtml(error.message)} Inicie o servidor local com <code>py server.py</code> e recarregue a página.</p><button class="form-submit" id="retry-connection">Tentar novamente</button></section>`;
  appContent.querySelector("#retry-connection").addEventListener("click", showMarket);
}

async function initialize() {
  try {
    const session = await api("/api/me");
    user = session.user;
    csrfToken = session.csrfToken;
    updateAccountButton();
    await showMarket();
  } catch (error) {
    updateAccountButton();
    renderServerError(error);
  }
}

searchInput.addEventListener("input", (event) => {
  searchTerm = event.target.value.trim();
  selectedCategory = "Todos";
  setNav("market");
  renderMarket(stores, products);
});
document.querySelectorAll(".nav-link").forEach((button) => button.addEventListener("click", () => {
  if (button.dataset.view === "market") showMarket();
  else if (button.dataset.view === "stores") showStores();
  else showSellerPortal();
}));
document.querySelector("#seller-portal-button").addEventListener("click", showSellerPortal);
document.querySelector("#admin-portal-button").addEventListener("click", showAdminPanel);
document.querySelector("#account-button").addEventListener("click", () => {
  if (user) logout();
  else showAuthModal("login");
});
document.querySelector("#open-cart").addEventListener("click", openCart);
document.querySelector("#close-cart").addEventListener("click", closeCart);
document.querySelector("#cart-backdrop").addEventListener("click", closeCart);
document.querySelector("#continue-shopping").addEventListener("click", () => { closeCart(); showStores(); });
document.querySelector("#checkout-button").addEventListener("click", checkout);
document.querySelector("#modal-backdrop").addEventListener("click", closeModal);
document.querySelector("#brand-home").addEventListener("click", (event) => { event.preventDefault(); showMarket(); });
document.querySelector("#footer-home").addEventListener("click", (event) => { event.preventDefault(); showMarket(); });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeCart();
    closeModal();
  }
});

initialize();
