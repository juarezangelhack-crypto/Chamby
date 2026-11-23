const STORAGE = {
  users: "encuentralab_users",
  current: "encuentralab_current",
  jobs: "encuentralab_jobs",
  applications: "encuentralab_applications",
  messages: "encuentralab_messages"
};

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function write(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

if (!localStorage.getItem(STORAGE.users)) write(STORAGE.users, []);
if (!localStorage.getItem(STORAGE.applications)) write(STORAGE.applications, []);
if (!localStorage.getItem(STORAGE.messages)) write(STORAGE.messages, []);

let jobs = [];
let users = read(STORAGE.users, []);
let applications = read(STORAGE.applications, []);
let messages = read(STORAGE.messages, []);
let currentUser = read(STORAGE.current, null);
let selectedType = null;
let activeConversation = null;

const views = document.querySelectorAll(".view");
const navLinks = document.querySelectorAll(".nav-link");
const accountButton = document.querySelector("#account-button");
const authDialog = document.querySelector("#auth-dialog");
const jobDialog = document.querySelector("#job-dialog");
const toast = document.querySelector("#toast");

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}
function showToast(text) {
  toast.textContent = text;
  toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("visible"), 2800);
}
function save() {
  write(STORAGE.jobs, jobs);
  write(STORAGE.users, users);
  write(STORAGE.applications, applications);
  write(STORAGE.messages, messages);
  write(STORAGE.current, currentUser);
}
function requireUser(action) {
  if (currentUser) return true;
  openAuth(action === "publicar" ? "publish" : "login");
  return false;
}
function switchView(name) {
  document.body.classList.toggle("authenticated", Boolean(currentUser));
  views.forEach((view) => view.classList.toggle("active", view.id === `${name}-view`));
  navLinks.forEach((link) => link.classList.toggle("active", link.dataset.view === name));
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (name === "mensajes") renderConversations();
  if (name === "anunciar") renderMyJobs();
  if (name === "dashboard") updateWelcomeCounts();
}

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
document.querySelector("#entry-login").addEventListener("click", () => openAuth("login"));
document.querySelector("#entry-register").addEventListener("click", () => openAuth("register"));
document.querySelector("#entry-publish").addEventListener("click", () => openAuth("publish"));
document.querySelectorAll("[data-select-type]").forEach((button) => button.addEventListener("click", () => {
  selectedType = button.dataset.selectType;
  document.querySelectorAll(".type-button").forEach((item) => item.classList.toggle("active", item.dataset.type === selectedType));
  renderJobs();
  switchView("buscar");
}));

function normalize(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
function getVisibleJobs() {
  const text = normalize(document.querySelector("#search-text").value.trim());
  const city = normalize(document.querySelector("#search-city").value.trim());
  const category = document.querySelector("#category-filter").value;
  const sort = document.querySelector("#sort-filter").value;
  let result = jobs.filter((job) => job.status === "Abierto");
  if (selectedType) result = result.filter((job) => job.type === selectedType);
  if (text) result = result.filter((job) => normalize(`${job.title} ${job.description} ${job.category}`).includes(text));
  if (city) result = result.filter((job) => normalize(job.city).includes(city));
  if (category !== "todas") result = result.filter((job) => job.category === category);
  result.sort((a, b) => sort === "rapidos" ? (a.type === "Rapido" ? -1 : 1) - (b.type === "Rapido" ? -1 : 1) : b.createdAt - a.createdAt);
  return result;
}
function updateWelcomeCounts() {
  const available = jobs.filter((job) => job.status === "Abierto");
  document.querySelector("#quick-count").textContent = available.filter((job) => job.type === "Rapido").length;
  document.querySelector("#formal-count").textContent = available.filter((job) => job.type === "Formal").length;
}
function renderJobs() {
  updateWelcomeCounts();
  document.querySelectorAll(".type-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.type === selectedType);
  });
  const result = getVisibleJobs();
  document.querySelector("#result-count").textContent = `${result.length} ${result.length === 1 ? "oportunidad" : "oportunidades"}`;
  const grid = document.querySelector("#job-grid");
  if (!result.length) {
    const hasOpenJobs = jobs.some((job) => job.status === "Abierto");
    grid.innerHTML = hasOpenJobs
      ? `<div class="empty-state"><h3>No encontramos coincidencias</h3><p>Cambia los filtros o prueba con otro distrito.</p></div>`
      : `<div class="empty-state"><h3>Aún no hay trabajos publicados</h3><p>Las ofertas aparecerán aquí cuando una persona publique una oportunidad.</p></div>`;
    return;
  }
  grid.innerHTML = result.map((job) => `
    <article class="job-card">
      <div class="job-card-head">
        <div class="job-types"><span class="pill ${job.type === "Rapido" ? "pill-rapido" : "pill-formal"}">${job.type === "Rapido" ? "Trabajo rápido" : "Trabajo formal"}</span><span class="pill pill-formal">${esc(job.category)}</span></div>
      </div>
      <h3>${esc(job.title)}</h3>
      <p class="job-meta">${esc(job.city)} · Publicado por ${esc(job.ownerName)}</p>
      <p class="job-description">${esc(job.description)}</p>
      <div class="job-card-foot">
        <div><span class="job-pay">${esc(job.pay)}</span><p class="job-meta">${esc(job.schedule)}</p></div>
        <button class="details-button" type="button" data-job-detail="${esc(job.id)}">Ver trabajo</button>
      </div>
    </article>`).join("");
}

document.querySelector("#search-form").addEventListener("submit", (event) => {
  event.preventEvent?.();
  event.preventDefault();
  renderJobs();
  document.querySelector(".listings-section").scrollIntoView({ behavior: "smooth" });
});
document.querySelectorAll(".type-button").forEach((button) => button.addEventListener("click", () => {
  selectedType = button.dataset.type;
  renderJobs();
}));
document.querySelector("#category-filter").addEventListener("change", renderJobs);
document.querySelector("#sort-filter").addEventListener("change", renderJobs);
document.querySelector("#search-text").addEventListener("input", renderJobs);
document.querySelector("#search-city").addEventListener("input", renderJobs);

document.querySelector("#job-grid").addEventListener("click", (event) => {
  const button = event.target.closest("[data-job-detail]");
  if (!button) return;
  openJobDetail(button.dataset.jobDetail);
});

function openJobDetail(jobId) {
  const job = jobs.find((item) => item.id === jobId);
  if (!job) return;
  document.querySelector("#job-dialog-content").innerHTML = `
    <p class="kicker">${job.type === "Rapido" ? "Trabajo rápido" : "Trabajo formal"} · ${esc(job.category)}</p>
    <h2 id="job-dialog-title">${esc(job.title)}</h2>
    <p><strong>${esc(job.ownerName)}</strong> · ${esc(job.city)}</p>
    <p>${esc(job.description)}</p>
    <p><strong>Pago:</strong> ${esc(job.pay)}<br><strong>Horario:</strong> ${esc(job.schedule)}</p>
    <div class="dialog-actions">
      <button class="primary-button" type="button" id="apply-job">Postularme</button>
      <button class="secondary-button" type="button" id="chat-owner">Contactar</button>
    </div>`;
  jobDialog.showModal();
  document.querySelector("#apply-job").addEventListener("click", () => applyForJob(job.id));
  document.querySelector("#chat-owner").addEventListener("click", () => openChatWith(job.ownerId, job.ownerName, job.id));
}

async function applyForJob(jobId) {
  if (!requireUser("postularme")) return;
  const response = await fetch("/api/applications", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId })
  });
  const result = await response.json();
  if (!response.ok) { showToast(result.error); return; }
  jobDialog.close();
  showToast("Postulación enviada. El anunciante recibió tu mensaje.");
  renderConversations();
}

document.querySelector("#publish-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!requireUser("publicar")) return;
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  if (submitButton.disabled) return;
  const submitLabel = submitButton.textContent;
  submitButton.disabled = true;
  submitButton.textContent = "Publicando...";
  const data = new FormData(form);
  const payload = {
    title: data.get("title").trim(),
    type: data.get("type"),
    category: data.get("category"),
    city: data.get("city").trim(),
    pay: data.get("pay").trim(),
    schedule: data.get("schedule").trim() || "Por acordar",
    description: data.get("description").trim()
  };
  try {
    const response = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) {
      showToast(result.error);
      return;
    }
    await loadServerJobs();
    form.reset();
    renderJobs();
    renderMyJobs();
    showToast("Tu trabajo fue publicado.");
  } catch {
    showToast("No se pudo publicar el trabajo. Revisa tu conexión e inténtalo otra vez.");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = submitLabel;
  }
});

function renderMyJobs() {
  const mine = currentUser ? jobs.filter((job) => job.ownerId === currentUser.id) : [];
  document.querySelector("#my-job-count").textContent = `${mine.length} anuncios`;
  document.querySelector("#my-job-list").innerHTML = mine.length ? mine.map((job) => {
    const applicants = applications.filter((item) => item.jobId === job.id);
    const applicantText = applicants.length ? `${applicantTextCount(applicants.length)} postulado${applicants.length === 1 ? "" : "s"}` : "Sin postulaciones";
    return `<div class="my-job-row">
      <div><strong>${esc(job.title)}</strong><span>${esc(job.city)} · ${applicantText} · ${job.status}</span></div>
      ${job.status === "Abierto" ? `<button class="secondary-button accept-button" type="button" data-accept="${esc(job.id)}">Aceptar trabajo</button>` : ""}
      <button class="secondary-button" type="button" data-view-applications="${esc(job.id)}">Ver postulantes</button>
    </div>`;
  }).join("") : `<div class="empty-state"><p>Todavía no has publicado trabajos.</p></div>`;
}
function applicantTextCount(count) { return String(count); }

document.querySelector("#my-job-list").addEventListener("click", (event) => {
  const accept = event.target.closest("[data-accept]");
  if (accept) acceptJob(accept.dataset.accept);
  const applicationsButton = event.target.closest("[data-view-applications]");
  if (applicationsButton) showApplicants(applicationsButton.dataset.viewApplications);
});

async function acceptJob(jobId) {
  if (!confirm("¿Confirmas que este trabajo ya fue aceptado? Se notificará a todas las personas que se postularon.")) return;
  const response = await fetch("/api/jobs/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId })
  });
  const result = await response.json();
  if (!response.ok) { showToast(result.error); return; }
  await loadServerJobs();
  renderJobs();
  renderMyJobs();
  showToast(applicants.length ? "Trabajo tomado y postulantes notificados." : "El trabajo quedó marcado como tomado.");
}

function showApplicants(jobId) {
  const applicants = applications.filter((item) => item.jobId === jobId);
  const job = jobs.find((item) => item.id === jobId);
  document.querySelector("#job-dialog-content").innerHTML = `
    <h2 id="job-dialog-title">Postulantes</h2>
    <p>${esc(job.title)}</p>
    ${applicants.length ? applicants.map((item) => `<div class="my-job-row"><div><strong>${esc(item.applicantName)}</strong><span>${item.status}</span></div><button class="secondary-button" type="button" data-chat-applicant="${esc(item.applicantId)}" data-job="${esc(job.id)}">Abrir chat</button></div>`).join("") : `<div class="empty-state"><p>No hay postulaciones todavía.</p></div>`}`;
  jobDialog.showModal();
  jobDialog.querySelectorAll("[data-chat-applicant]").forEach((button) => button.addEventListener("click", () => {
    jobDialog.close();
    openChatWith(button.dataset.chatApplicant, button.textContent === "Abrir chat" ? applicants.find((item) => item.applicantId === button.dataset.chatApplicant).applicantName : "Usuario", button.dataset.job);
  }));
}

function conversationIdFor(firstId, secondId, jobId) {
  return `${jobId}:${[firstId, secondId].sort().join(":")}`;
}
function ensureConversation(personId, personName, jobId, jobTitle) {
  const conversations = read("encuentralab_conversations", []);
  const id = conversationIdFor(currentUser?.id || personId, personId === currentUser?.id ? jobId : personId, jobId);
  // Conversations are derived from applications and messages, so no separate storage is required.
  return id;
}

function openChatWith(personId, personName, jobId) {
  if (!requireUser("chatear")) return;
  const job = jobs.find((item) => item.id === jobId);
  activeConversation = conversationIdFor(currentUser.id, personId, jobId);
  if (!messages.some((item) => item.conversationId === activeConversation)) {
    messages.push({ conversationId: activeConversation, senderId: currentUser.id, text: `Hola, me interesa hablar sobre "${job?.title || "esta oportunidad"}".`, at: Date.now() });
  }
  save();
  jobDialog.close();
  switchView("mensajes");
  renderConversations();
}

function renderConversations() {
  const unread = new Set();
  const conversationIds = [...new Set(messages.map((item) => item.conversationId))];
  const conversationList = document.querySelector("#conversation-list");
  const conversations = conversationIds.map((id) => {
    const parts = id.split(":");
    const jobId = parts[0];
    const ids = parts.slice(1);
    const otherId = ids.find((item) => item !== currentUser?.id);
    const job = jobs.find((item) => item.id === jobId);
    let otherName = "Usuario";
    if (otherId) {
      const application = applications.find((item) => item.applicantId === otherId && item.jobId === jobId);
      const owner = users.find((item) => item.id === otherId);
      otherName = application?.applicantName || owner?.name || job?.ownerName || "Usuario";
    }
    const chatMessages = messages.filter((item) => item.conversationId === id);
    const last = chatMessages[chatMessages.length - 1];
    if (last && last.senderId !== currentUser?.id && last.senderId !== "system") unread.add(id);
    return { id, jobId, otherId, otherName, jobTitle: job?.title || "Trabajo", last };
  }).filter((item) => item.otherId);

  conversationList.innerHTML = conversations.length ? conversations.map((item) => `
    <button type="button" class="conversation-item ${activeConversation === item.id ? "active" : ""}" data-conversation="${esc(item.id)}">
      <strong>${esc(item.otherName)}</strong>
      <span>${esc(item.jobTitle)}</span>
    </button>`).join("") : `<div class="empty-state"><p>Tus conversaciones aparecerán aquí.</p></div>`;
  const badge = document.querySelector("#message-badge");
  badge.hidden = unread.size === 0;
  badge.textContent = unread.size;
  if (activeConversation) renderChat(activeConversation);
  else {
    document.querySelector("#chat-empty").hidden = false;
    document.querySelector("#chat-active").hidden = true;
  }
}

document.querySelector("#conversation-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-conversation]");
  if (!button) return;
  activeConversation = button.dataset.conversation;
  renderConversations();
  renderChat(activeConversation);
});

function renderChat(conversationId) {
  const chatMessages = messages.filter((item) => item.conversationId === conversationId);
  const parts = conversationId.split(":");
  const job = jobs.find((item) => item.id === parts[0]);
  const otherId = parts.slice(1).find((item) => item !== currentUser?.id);
  const application = applications.find((item) => item.applicantId === otherId && item.jobId === job?.id);
  const otherUser = users.find((item) => item.id === otherId);
  document.querySelector("#chat-empty").hidden = true;
  document.querySelector("#chat-active").hidden = false;
  document.querySelector("#chat-name").textContent = application?.applicantName || otherUser?.name || job?.ownerName || "Usuario";
  document.querySelector("#chat-job").textContent = job?.title || "Trabajo";
  document.querySelector("#chat-messages").innerHTML = chatMessages.length ? chatMessages.map((item) => `
    <div class="message ${item.senderId === currentUser?.id ? "mine" : ""}">
      ${esc(item.text)}
      ${item.senderId === "system" ? "<small>Mensaje automático</small>" : ""}
    </div>`).join("") : `<p class="job-meta">No hay mensajes todavía.</p>`;
  document.querySelector("#chat-messages").scrollTop = document.querySelector("#chat-messages").scrollHeight;
}

document.querySelector("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#chat-input");
  const text = input.value.trim();
  if (!text || !activeConversation) return;
  const response = await fetch("/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: activeConversation, text })
  });
  if (!response.ok) { showToast("No se pudo enviar el mensaje."); return; }
  await loadServerMessages();
  input.value = "";
  renderConversations();
  renderChat(activeConversation);
});

async function loadServerMessages() {
  if (!currentUser) return;
  try {
    const response = await fetch("/api/messages");
    if (!response.ok) return;
    const result = await response.json();
    messages = result.messages.map((message) => ({
      conversationId: message.conversation_id,
      senderId: message.sender_id,
      text: message.text,
      at: message.created_at
    }));
    renderConversations();
  } catch {}
}

function openAuth(action) {
  let mode = action === "register" ? "register" : "login";
  document.querySelector("#auth-content").innerHTML = `
    <div class="auth-tabs">
      <button type="button" class="${mode === "login" ? "active" : ""}" data-auth-tab="login">Entrar</button>
      <button type="button" class="${mode === "register" ? "active" : ""}" data-auth-tab="register">Crear cuenta</button>
    </div>
    <h2 id="auth-title">${mode === "register" ? "Crea tu cuenta en Chambly" : "Accede a Chambly"}</h2>
    <form id="auth-form" class="publish-form" style="padding:0;border:0">
      <div class="field auth-name-field" ${mode === "login" ? "hidden" : ""}><label for="auth-name">Nombre completo</label><input id="auth-name" maxlength="60"></div>
      <div class="field auth-district-field" ${mode === "login" ? "hidden" : ""}><label for="auth-district">Distrito de Lima</label><input id="auth-district" list="district-list"></div>
      <div class="field"><label for="auth-email">Correo electrónico</label><input id="auth-email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="auth-password">Contraseña</label><input id="auth-password" type="password" autocomplete="${mode === "register" ? "new-password" : "current-password"}" minlength="10" required></div>
      <button class="primary-button" id="auth-submit" type="submit">${mode === "register" ? "Crear cuenta" : action === "publish" ? "Continuar" : "Iniciar sesión"}</button>
    </form>`;
  authDialog.showModal();

  document.querySelectorAll("[data-auth-tab]").forEach((button) => button.addEventListener("click", () => {
    mode = button.dataset.authTab;
    document.querySelectorAll("[data-auth-tab]").forEach((item) => item.classList.toggle("active", item === button));
    document.querySelector(".auth-name-field").hidden = mode !== "register";
    document.querySelector(".auth-district-field").hidden = mode !== "register";
    document.querySelector("#auth-password").autocomplete = mode === "register" ? "new-password" : "current-password";
    document.querySelector("#auth-title").textContent = mode === "register" ? "Crea tu cuenta en Chambly" : "Accede a Chambly";
    document.querySelector("#auth-submit").textContent = mode === "register" ? "Crear cuenta" : action === "publish" ? "Continuar" : "Iniciar sesión";
  }));

  document.querySelector("#auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = document.querySelector("#auth-email").value.trim().toLowerCase();
    const password = document.querySelector("#auth-password").value;

    if (mode === "login") {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const result = await response.json();
      if (!response.ok) { showToast(result.error); return; }
      currentUser = result.user;
      write(STORAGE.current, currentUser);
      accountButton.textContent = currentUser.name.split(" ")[0];
      authDialog.close();
      await loadServerJobs();
      switchView(action === "publish" ? "anunciar" : "dashboard");
      showToast(`Bienvenido, ${currentUser.name}.`);
      return;
    }

    const name = document.querySelector("#auth-name").value.trim();
    const district = document.querySelector("#auth-district").value.trim();
    const response = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password, district })
    });
    const result = await response.json();
    if (!response.ok) { showToast(result.error); return; }

    document.querySelector("#auth-content").innerHTML = `
      <h2 id="auth-title">Revisa tu correo</h2>
      <p>${esc(result.message || "Firebase envió un enlace de verificación")} a <strong>${esc(email)}</strong>.</p>
      <p>Abre el enlace para verificar tu cuenta. Luego vuelve aquí e inicia sesión.</p>
      <button class="secondary-button" type="button" id="back-to-login">Volver a iniciar sesión</button>`;
    document.querySelector("#back-to-login").addEventListener("click", () => {
      authDialog.close();
      openAuth(action === "publish" ? "publish" : "login");
    });
  });
}

accountButton.addEventListener("click", () => {
  if (!currentUser) openAuth("");
  else openUserMenu();
});
function openUserMenu() {
  document.querySelector("#auth-content").innerHTML = `
    <h2 id="auth-title">Mi cuenta</h2>
    <p><strong>${esc(currentUser.name)}</strong><br>${esc(currentUser.email)}</p>
    <div class="dialog-actions"><button class="secondary-button" type="button" id="logout-button">Cerrar sesión</button></div>`;
  authDialog.showModal();
  document.querySelector("#logout-button").addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    currentUser = null;
    write(STORAGE.current, null);
    activeConversation = null;
    accountButton.textContent = "Entrar";
    authDialog.close();
    switchView("inicio");
    showToast("Sesión cerrada.");
  });
}

document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
}));

async function loadServerJobs() {
  try {
    const response = await fetch("/api/jobs");
    if (!response.ok) {
      showToast("No se pudieron cargar los trabajos. Inténtalo de nuevo.");
      return;
    }
    const result = await response.json();
    jobs = result.jobs.map((job) => ({
      id: job.id,
      title: job.title,
      type: job.type,
      category: job.category,
      city: job.city,
      pay: job.pay,
      schedule: job.schedule,
      description: job.description,
      ownerId: job.owner_id,
      ownerName: job.owner_name,
      status: job.status,
      createdAt: job.created_at
    }));
    renderJobs();
  } catch {
    showToast("No se pudieron cargar los trabajos. Revisa tu conexión e inténtalo de nuevo.");
  }
}

function announceNewApplication() { updateMessageBadge(); }
function updateMessageBadge() {
  if (!currentUser) return;
  const relevant = messages.filter((item) => item.conversationId.includes(currentUser.id) && item.senderId !== currentUser.id);
  const badge = document.querySelector("#message-badge");
  badge.hidden = relevant.length === 0;
  badge.textContent = relevant.length;
}

async function restoreSecureSession() {
  try {
    const response = await fetch("/api/session");
    if (response.ok) {
      const result = await response.json();
      currentUser = result.user;
      write(STORAGE.current, currentUser);
      accountButton.textContent = currentUser.name.split(" ")[0];
      switchView("dashboard");
    } else {
      currentUser = null;
      write(STORAGE.current, null);
      accountButton.textContent = "Entrar";
      switchView("inicio");
    }
  } catch {
    if (currentUser) {
      accountButton.textContent = currentUser.name.split(" ")[0];
      switchView("dashboard");
    } else {
      switchView("inicio");
    }
  }
}

restoreSecureSession();
loadServerJobs();
loadServerMessages();
renderJobs();
renderConversations();

if (new URLSearchParams(window.location.search).get("verified") === "1") {
  history.replaceState(null, "", window.location.pathname);
  showToast("Correo verificado. Ya puedes iniciar sesión.");
}
