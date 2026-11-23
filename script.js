const STORAGE = {
  users: "encuentralab_users",
  current: "encuentralab_current",
  jobs: "encuentralab_jobs",
  applications: "encuentralab_applications",
  messages: "encuentralab_messages"
};
const MAX_JOB_APPLICANTS = 10;
const pageType = document.body.dataset.jobType;

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
let profile = null;
let activeConversation = null;
let messageStream = null;
let messageUpdateVersion = 0;

const views = document.querySelectorAll(".view");
const accountButton = document.querySelector("#account-button");
const authDialog = document.querySelector("#auth-dialog");
const jobDialog = document.querySelector("#job-dialog");
const profileDialog = document.querySelector("#profile-dialog");
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
  if (["anunciar", "perfil", "mensajes"].includes(name) && !requireUser(name === "anunciar" ? "publicar" : name)) return;
  document.body.classList.toggle("authenticated", Boolean(currentUser));
  views.forEach((view) => view.classList.toggle("active", view.id === `${name}-view`));
  document.querySelectorAll(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.view === name));
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (name === "buscar") loadServerJobs(true);
  if (name === "mensajes") renderConversations();
  if (name === "anunciar") renderMyJobs();
  if (name === "perfil") loadServerProfile();
}

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));

function getVisibleJobs() {
  const category = document.querySelector("#category-filter").value;
  const district = document.querySelector("#district-filter").value.trim().toLocaleLowerCase("es");
  const sort = document.querySelector("#sort-filter").value;
  let result = jobs.filter((job) => job.type === pageType && job.status === "Abierto" && job.applicantCount < job.applicantLimit);
  if (category !== "todas") result = result.filter((job) => job.category === category);
  if (district) result = result.filter((job) => String(job.city || "").trim().toLocaleLowerCase("es") === district);
  if (sort === "recientes") result.sort((a, b) => b.createdAt - a.createdAt);
  return result;
}
function renderJobs() {
  const result = getVisibleJobs();
  document.querySelector("#result-count").textContent = `${result.length} ${result.length === 1 ? "oportunidad" : "oportunidades"}`;
  const grid = document.querySelector("#job-grid");
  if (!result.length) {
    const hasAvailableJobs = jobs.some((job) => job.type === pageType && job.status === "Abierto" && job.applicantCount < job.applicantLimit);
    const hasJobsInMode = jobs.some((job) => job.type === pageType);
    grid.innerHTML = hasAvailableJobs
      ? `<div class="empty-state"><h3>No encontramos coincidencias</h3><p>Cambia los filtros o prueba con otro distrito.</p></div>`
      : hasJobsInMode
        ? `<div class="empty-state"><h3>No hay trabajos disponibles</h3><p>Los anuncios se ocultan al alcanzar el máximo de postulantes que eligió quien los publicó.</p></div>`
        : `<div class="empty-state"><h3>Aún no hay oportunidades</h3><p>Las ofertas de esta modalidad aparecerán aquí cuando publiquen un trabajo.</p></div>`;
    return;
  }
  grid.innerHTML = result.map((job) => `
    <article class="job-card">
      <div class="job-card-head">
        <div class="job-types"><span class="pill pill-formal">${esc(job.category)}</span></div>
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

document.querySelector("#category-filter").addEventListener("change", renderJobs);
const districtFilter = document.querySelector("#district-filter");
document.querySelectorAll("#district-list option").forEach((option) => {
  districtFilter.add(new Option(option.value, option.value));
});
districtFilter.addEventListener("change", renderJobs);
document.querySelector("#sort-filter").addEventListener("change", renderJobs);

document.querySelector("#job-grid").addEventListener("click", (event) => {
  const button = event.target.closest("[data-job-detail]");
  if (!button) return;
  openJobDetail(button.dataset.jobDetail);
});

function openJobDetail(jobId) {
  const job = jobs.find((item) => item.id === jobId);
  if (!job) return;
  const isOwner = currentUser?.id === job.ownerId;
  const applicantCount = Number(job.applicantCount || 0);
  const applicantLimit = Number(job.applicantLimit || MAX_JOB_APPLICANTS);
  const isFull = applicantCount >= applicantLimit;
  document.querySelector("#job-dialog-content").innerHTML = `
    <p class="kicker">${job.type === "Rapido" ? "Trabajo rápido" : "Trabajo formal"} · ${esc(job.category)}</p>
    <h2 id="job-dialog-title">${esc(job.title)}</h2>
    <p><strong>${esc(job.ownerName)}</strong> · ${esc(job.city)}</p>
    <p>${esc(job.description)}</p>
    <p><strong>Pago:</strong> ${esc(job.pay)}<br><strong>Horario:</strong> ${esc(job.schedule)}</p>
    <p><strong>Postulantes:</strong> ${applicantCount}/${applicantLimit}</p>
    ${isOwner
      ? `<p class="owner-notice">Este es tu anuncio. No puedes postularte a tu propio trabajo.</p>`
      : `${isFull ? `<p class="owner-notice">Se alcanzó el máximo de ${applicantLimit} postulantes. Ya no se aceptan más postulaciones.</p>` : ""}
        <div class="dialog-actions">
          ${isFull ? "" : `<button class="primary-button" type="button" id="apply-job">Postularme</button>`}
          <button class="secondary-button" type="button" id="chat-owner">Contactar</button>
        </div>`}`;
  jobDialog.showModal();
  if (!isOwner) {
    if (!isFull) document.querySelector("#apply-job").addEventListener("click", () => applyForJob(job.id));
    document.querySelector("#chat-owner").addEventListener("click", () => openChatWith(job.ownerId, job.ownerName, job.id));
  }
}

async function applyForJob(jobId) {
  if (!requireUser("postularme")) return;
  if (!profile?.district) {
    jobDialog.close();
    showToast("Completa tu distrito en Mi perfil antes de postularte.");
    switchView("perfil");
    return;
  }
  const response = await fetch("/api/applications", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId })
  });
  const result = await response.json();
  if (!response.ok) {
    if (result.code === "MAX_APPLICANTS") {
      jobDialog.close();
      await loadServerJobs();
      openJobDetail(jobId);
      return;
    }
    if (result.code === "PROFILE_REQUIRED") {
      jobDialog.close();
      showToast(result.error);
      switchView("perfil");
      return;
    }
    showToast(result.error);
    return;
  }
  await Promise.all([loadServerApplications(), loadServerMessages(), loadServerJobs()]);
  jobDialog.close();
  showToast("Postulación enviada. El anunciante recibió tu mensaje.");
  renderMyJobs();
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
    type: pageType,
    category: data.get("category"),
    applicantLimit: Number(data.get("applicantLimit")),
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

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
    reader.readAsDataURL(file);
  });
}

document.querySelector("#profile-photo").addEventListener("change", async (event) => {
  const file = event.currentTarget.files[0];
  if (!file) return;
  try {
    document.querySelector("#profile-photo-preview").src = await readFileAsDataUrl(file);
  } catch {
    showToast("No se pudo abrir la imagen seleccionada.");
  }
});

document.querySelector("#profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!requireUser("perfil")) return;
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const photoFile = document.querySelector("#profile-photo").files[0];
  const cvFile = document.querySelector("#profile-cv").files[0];
  const payload = { type: pageType, district: document.querySelector("#profile-district").value.trim() };
  try {
    if (photoFile) {
      if (photoFile.size > 2 * 1024 * 1024) {
        showToast("La foto debe pesar como máximo 2 MB.");
        return;
      }
      payload.photoData = (await readFileAsDataUrl(photoFile)).split(",", 2)[1];
      payload.photoMime = photoFile.type;
    }
    if (cvFile) {
      if (cvFile.size > 5 * 1024 * 1024) {
        showToast("El CV debe pesar como máximo 5 MB.");
        return;
      }
      if (cvFile.type !== "application/pdf" && !cvFile.name.toLowerCase().endsWith(".pdf")) {
        showToast("El CV debe ser un archivo PDF.");
        return;
      }
      payload.cvData = (await readFileAsDataUrl(cvFile)).split(",", 2)[1];
      payload.cvName = cvFile.name;
    }
  } catch {
    showToast("No se pudieron leer los archivos seleccionados.");
    return;
  }
  button.disabled = true;
  try {
    const response = await fetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) {
      showToast(result.error || "No se pudo guardar tu perfil.");
      return;
    }
    form.reset();
    profile = result.profile;
    updateProfileForm();
    districtFilter.value = profile.district || "";
    renderJobs();
    showToast("Perfil guardado para esta modalidad.");
  } catch {
    showToast("No se pudo guardar tu perfil. Revisa tu conexión e inténtalo otra vez.");
  } finally {
    button.disabled = false;
  }
});

async function loadServerProfile() {
  if (!currentUser) return;
  try {
    const response = await fetch(`/api/profiles?type=${encodeURIComponent(pageType)}`);
    const result = await response.json();
    if (!response.ok) {
      showToast(result.error || "No se pudo cargar tu perfil.");
      return;
    }
    const previousDistrict = profile?.district || "";
    profile = result.profile;
    if (!districtFilter.value || districtFilter.value === previousDistrict) {
      districtFilter.value = profile?.district || "";
    }
    updateProfileForm();
    renderJobs();
  } catch {
    showToast("No se pudo cargar tu perfil. Revisa tu conexión.");
  }
}

function updateProfileForm() {
  if (!profile) return;
  document.querySelector("#profile-district").value = profile.district || "";
  document.querySelector("#profile-photo-preview").src = profile.photoData
    ? `data:${profile.photoMime};base64,${profile.photoData}`
    : "assets/no-profile.svg";
  const cvLink = document.querySelector("#profile-cv-current");
  cvLink.hidden = !profile.cvName;
  if (profile.cvName) {
    cvLink.href = `/api/profiles/${encodeURIComponent(currentUser.id)}/cv?type=${encodeURIComponent(pageType)}`;
    cvLink.textContent = `Ver CV guardado: ${profile.cvName}`;
  }
}

function renderMyJobs() {
  const mine = currentUser ? jobs.filter((job) => job.ownerId === currentUser.id && job.type === pageType) : [];
  document.querySelector("#my-job-count").textContent = `${mine.length} anuncios`;
  document.querySelector("#my-job-list").innerHTML = mine.length ? mine.map((job) => {
    const applicants = applications.filter((item) => item.jobId === job.id);
    const applicantText = `${applicantTextCount(applicants.length)}/${job.applicantLimit} postulantes`;
    return `<div class="my-job-row">
      <div><strong>${esc(job.title)}</strong><span>${esc(job.city)} · ${applicantText} · ${job.status}</span></div>
      ${job.status === "Abierto" ? `<button class="secondary-button accept-button" type="button" data-accept="${esc(job.id)}">Aceptar trabajo</button>` : ""}
      <button class="secondary-button" type="button" data-view-applications="${esc(job.id)}">Ver postulantes</button>
      <button class="secondary-button delete-button" type="button" data-delete-job="${esc(job.id)}">Eliminar</button>
    </div>`;
  }).join("") : `<div class="empty-state"><p>Todavía no has publicado trabajos.</p></div>`;
}
function applicantTextCount(count) { return String(count); }

document.querySelector("#my-job-list").addEventListener("click", async (event) => {
  const remove = event.target.closest("[data-delete-job]");
  if (remove) {
    await deleteJob(remove.dataset.deleteJob);
    return;
  }
  const accept = event.target.closest("[data-accept]");
  if (accept) acceptJob(accept.dataset.accept);
  const applicationsButton = event.target.closest("[data-view-applications]");
  if (applicationsButton) {
    await loadServerApplications();
    renderMyJobs();
    showApplicants(applicationsButton.dataset.viewApplications);
  }
});

async function acceptJob(jobId) {
  if (!confirm("¿Confirmas que este trabajo ya fue aceptado? Se notificará a todas las personas que se postularon.")) return;
  const applicantCount = applications.filter((item) => item.jobId === jobId).length;
  const response = await fetch("/api/jobs/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId })
  });
  const result = await response.json();
  if (!response.ok) { showToast(result.error); return; }
  await Promise.all([loadServerJobs(), loadServerApplications(), loadServerMessages()]);
  renderJobs();
  renderMyJobs();
  showToast(applicantCount ? "Trabajo tomado y postulantes notificados." : "El trabajo quedó marcado como tomado.");
}

async function deleteJob(jobId) {
  if (!confirm("¿Eliminar este anuncio? No aparecerá más en la lista de trabajos.")) return;
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok) {
      showToast(result.error);
      return;
    }
    await loadServerJobs();
    renderJobs();
    renderMyJobs();
    showToast("Anuncio eliminado.");
  } catch {
    showToast("No se pudo eliminar el anuncio. Inténtalo otra vez.");
  }
}

function showApplicants(jobId, notice = "") {
  const applicants = applications.filter((item) => item.jobId === jobId);
  const job = jobs.find((item) => item.id === jobId);
  document.querySelector("#job-dialog-content").innerHTML = `
    <h2 id="job-dialog-title">Postulantes</h2>
    <p>${esc(job.title)} · ${applicants.length}/${job.applicantLimit} postulantes</p>
    ${notice ? `<p class="owner-notice" role="status">${esc(notice)}</p>` : ""}
    ${applicants.length ? applicants.map((item) => `<div class="my-job-row"><div><strong>${esc(item.applicantName)}</strong><span>${esc(item.applicantDistrict || "Distrito no registrado")} · ${esc(item.status)}</span></div><button class="secondary-button" type="button" data-view-profile="${esc(item.applicantId)}" data-job="${esc(job.id)}">Ver perfil</button><button class="secondary-button" type="button" data-chat-applicant="${esc(item.applicantId)}" data-job="${esc(job.id)}">Abrir chat</button><button class="secondary-button delete-button" type="button" data-remove-application="${esc(item.id)}" data-job="${esc(job.id)}" data-applicant-name="${esc(item.applicantName)}">Eliminar</button></div>`).join("") : `<div class="empty-state"><p>No hay postulaciones todavía.</p></div>`}`;
  jobDialog.showModal();
  jobDialog.querySelectorAll("[data-view-profile]").forEach((button) => button.addEventListener("click", () => {
    showApplicantProfile(button.dataset.viewProfile, button.dataset.job);
  }));
  jobDialog.querySelectorAll("[data-chat-applicant]").forEach((button) => button.addEventListener("click", () => {
    jobDialog.close();
    const applicant = applicants.find((item) => item.applicantId === button.dataset.chatApplicant);
    openChatWith(button.dataset.chatApplicant, applicant?.applicantName || "Usuario", button.dataset.job);
  }));
  jobDialog.querySelectorAll("[data-remove-application]").forEach((button) => button.addEventListener("click", () => {
    removeApplicant(button.dataset.removeApplication, button.dataset.job, button.dataset.applicantName);
  }));
}

async function showApplicantProfile(applicantId, jobId) {
  try {
    const response = await fetch(`/api/profiles/${encodeURIComponent(applicantId)}?type=${encodeURIComponent(pageType)}&jobId=${encodeURIComponent(jobId)}`);
    const result = await response.json();
    if (!response.ok) {
      showToast(result.error || "No se pudo cargar el perfil.");
      return;
    }
    const applicantProfile = result.profile;
    const photo = applicantProfile.photoData
      ? `data:${applicantProfile.photoMime};base64,${applicantProfile.photoData}`
      : "assets/no-profile.svg";
    const cv = applicantProfile.cvName
      ? `<a class="profile-cv-link" href="/api/profiles/${encodeURIComponent(applicantId)}/cv?type=${encodeURIComponent(pageType)}&jobId=${encodeURIComponent(jobId)}" target="_blank" rel="noopener">Ver CV en PDF</a>`
      : `<p>Este usuario aún no ha subido un CV.</p>`;
    document.querySelector("#profile-dialog-content").innerHTML = `
      <img class="profile-avatar" src="${photo}" alt="Foto de ${esc(applicantProfile.name)}">
      <h2 id="profile-dialog-title">${esc(applicantProfile.name)}</h2>
      <p><strong>Distrito:</strong> ${esc(applicantProfile.district || "No indicado")}</p>${cv}
      <button class="secondary-button" type="button" id="back-to-applicants">Volver a postulantes</button>`;
    profileDialog.showModal();
    document.querySelector("#back-to-applicants").addEventListener("click", () => {
      profileDialog.close();
    });
  } catch {
    showToast("No se pudo cargar el perfil. Inténtalo otra vez.");
  }
}

async function removeApplicant(applicationId, jobId, applicantName) {
  if (!confirm(`¿Eliminar la postulación de ${applicantName}? Se liberará un cupo y se conservará el historial del chat.`)) return;
  try {
    const response = await fetch(`/api/applications/${encodeURIComponent(applicationId)}`, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok) {
      showToast(result.error || "No se pudo quitar la postulación.");
      return;
    }
    await Promise.all([loadServerApplications(), loadServerJobs()]);
    jobDialog.close();
    showApplicants(jobId, "Postulación eliminada. Se liberó un cupo y se conservó el chat.");
  } catch {
    showToast("No se pudo quitar la postulación. Inténtalo otra vez.");
  }
}

function conversationIdFor(firstId, secondId, jobId) {
  return `${jobId}:${[firstId, secondId].sort().join(":")}`;
}
async function openChatWith(personId, personName, jobId) {
  if (!requireUser("chatear")) return;
  const job = jobs.find((item) => item.id === jobId);
  if (!job || !personId || personId === currentUser.id) {
    showToast("No se pudo abrir esta conversación.");
    return;
  }
  activeConversation = conversationIdFor(currentUser.id, personId, jobId);
  jobDialog.close();
  switchView("mensajes");
  if (!await loadServerMessages()) {
    showToast("No se pudo cargar el chat. Inicia sesión de nuevo e inténtalo.");
    return;
  }
  if (!messages.some((item) => item.conversationId === activeConversation)) {
    try {
      const response = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: activeConversation,
          text: `Hola, me interesa hablar sobre "${job.title}".`
        })
      });
      const result = await response.json();
      if (!response.ok) {
        showToast(result.error || "No se pudo iniciar la conversación.");
        return;
      }
    } catch {
      showToast("No se pudo iniciar la conversación. Revisa tu conexión e inténtalo de nuevo.");
      return;
    }
  }
  await loadServerMessages();
  renderConversations();
}

function conversationPeerName(conversationId) {
  const [jobId, ...participantIds] = conversationId.split(":");
  const otherId = participantIds.find((item) => item !== currentUser?.id);
  const job = jobs.find((item) => item.id === jobId);
  const application = applications.find((item) => item.applicantId === otherId && item.jobId === jobId);
  const peerMessage = messages.find((item) => item.conversationId === conversationId
    && item.senderId === otherId && item.senderName);
  return application?.applicantName || peerMessage?.senderName
    || (otherId === job?.ownerId ? job?.ownerName : null) || "Usuario";
}

function renderConversations() {
  const conversationIds = [...new Set(messages.map((item) => item.conversationId))];
  const conversationList = document.querySelector("#conversation-list");
  const conversations = conversationIds.map((id) => {
    const parts = id.split(":");
    const jobId = parts[0];
    const ids = parts.slice(1);
    const otherId = ids.find((item) => item !== currentUser?.id);
    const job = jobs.find((item) => item.id === jobId);
    const chatMessages = messages.filter((item) => item.conversationId === id);
    if (chatMessages[0]?.jobType !== pageType) return null;
    const last = chatMessages[chatMessages.length - 1];
    return { id, jobId, otherId, otherName: conversationPeerName(id), jobTitle: job?.title || chatMessages[0]?.jobTitle || "Trabajo", last };
  }).filter((item) => item?.otherId);
  if (activeConversation && !conversations.some((item) => item.id === activeConversation)) {
    activeConversation = null;
  }
  if (!activeConversation && conversations.length === 1) {
    activeConversation = conversations[0].id;
  }

  conversationList.innerHTML = conversations.length ? conversations.map((item) => `
    <button type="button" class="conversation-item ${activeConversation === item.id ? "active" : ""}" data-conversation="${esc(item.id)}">
      <strong>${esc(item.otherName)}</strong>
      <span>${esc(item.jobTitle)}</span>
    </button>`).join("") : `<div class="empty-state"><p>Tus conversaciones aparecerán aquí.</p></div>`;
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
  document.querySelector("#chat-empty").hidden = true;
  document.querySelector("#chat-active").hidden = false;
  document.querySelector("#chat-name").textContent = conversationPeerName(conversationId);
  document.querySelector("#chat-job").textContent = job?.title || chatMessages[0]?.jobTitle || "Trabajo";
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
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  const text = input.value.trim();
  if (!text || !activeConversation || !currentUser || submitButton.disabled) return;
  submitButton.disabled = true;
  try {
    const response = await fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: activeConversation, text })
    });
    const result = await response.json();
    if (!response.ok) {
      showToast(result.error || "No se pudo enviar el mensaje.");
      return;
    }
    input.value = "";
    await loadServerMessages();
    renderConversations();
    renderChat(activeConversation);
  } catch {
    showToast("No se pudo enviar el mensaje. Revisa tu conexión e inténtalo de nuevo.");
  } finally {
    submitButton.disabled = false;
  }
});

async function loadServerMessages() {
  if (!currentUser) return false;
  const requestVersion = ++messageUpdateVersion;
  try {
    const response = await fetch("/api/messages");
    if (!response.ok) return false;
    const result = await response.json();
    if (requestVersion !== messageUpdateVersion) return false;
    messages = result.messages.map((message) => ({
      conversationId: message.conversation_id,
      senderId: message.sender_id,
      text: message.text,
      jobType: message.job_type,
      at: message.created_at,
      senderName: message.sender_name,
      jobTitle: message.job_title,
      ownerId: message.owner_id,
      ownerName: message.owner_name
    }));
    renderConversations();
    return true;
  } catch {
    if (document.querySelector("#mensajes-view").classList.contains("active")) {
      showToast("No se pudieron actualizar los mensajes. Revisa tu conexión.");
    }
    return false;
  }
}

function connectMessageStream() {
  if (!currentUser || !window.EventSource) return;
  if (messageStream) messageStream.close();
  const stream = new EventSource("/api/messages/stream");
  messageStream = stream;
  stream.onmessage = (event) => {
    if (messageStream !== stream) return;
    try {
      const result = JSON.parse(event.data);
      messageUpdateVersion += 1;
      messages = result.messages.map((message) => ({
        conversationId: message.conversation_id,
        senderId: message.sender_id,
        text: message.text,
        jobType: message.job_type,
        at: message.created_at,
        senderName: message.sender_name,
        jobTitle: message.job_title,
        ownerId: message.owner_id,
        ownerName: message.owner_name
      }));
      renderConversations();
    } catch {
      stream.close();
      messageStream = null;
      showToast("No se pudieron actualizar los mensajes en tiempo real.");
    }
  };
}

async function loadServerApplications() {
  if (!currentUser) return;
  try {
    const response = await fetch("/api/applications");
    const result = await response.json();
    if (!response.ok) {
      showToast(result.error || "No se pudieron cargar las postulaciones.");
      return;
    }
    applications = result.applications.map((application) => ({
      id: application.id,
      jobId: application.job_id,
      applicantId: application.applicant_id,
      applicantName: application.account_name || application.applicant_name,
      applicantDistrict: application.applicant_district || application.account_district,
      jobType: application.job_type,
      status: application.status,
      at: application.created_at
    }));
    renderMyJobs();
  } catch {
    showToast("No se pudieron cargar las postulaciones. Inténtalo de nuevo.");
  }
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
      <div class="field"><label for="auth-password">Contraseña</label><input id="auth-password" type="password" autocomplete="${mode === "register" ? "new-password" : "current-password"}" minlength="6" required></div>
      <button class="auth-recovery" id="forgot-password" type="button" ${mode === "register" ? "hidden" : ""}>¿Olvidaste tu contraseña?</button>
      <p class="auth-feedback" id="auth-feedback" role="status" aria-live="polite" hidden></p>
      <button class="primary-button" id="auth-submit" type="submit">${mode === "register" ? "Crear cuenta" : action === "publish" ? "Continuar" : "Iniciar sesión"}</button>
    </form>`;
  authDialog.showModal();

  const recoveryButton = document.querySelector("#forgot-password");
  const authFeedback = document.querySelector("#auth-feedback");
  recoveryButton.addEventListener("click", async () => {
    const emailInput = document.querySelector("#auth-email");
    const email = emailInput.value.trim().toLowerCase();
    if (!email || !emailInput.checkValidity()) {
      emailInput.reportValidity();
      return;
    }
    recoveryButton.disabled = true;
    recoveryButton.textContent = "Enviando enlace...";
    authFeedback.hidden = true;
    try {
      const response = await fetch("/api/password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email })
      });
      const result = await response.json();
      authFeedback.textContent = result.message || result.error || "No se pudo enviar el enlace.";
      authFeedback.classList.toggle("error", !response.ok);
      authFeedback.hidden = false;
    } catch {
      authFeedback.textContent = "No se pudo enviar el enlace. Revisa tu conexión e inténtalo de nuevo.";
      authFeedback.classList.add("error");
      authFeedback.hidden = false;
    } finally {
      recoveryButton.disabled = false;
      recoveryButton.textContent = "¿Olvidaste tu contraseña?";
    }
  });

  document.querySelectorAll("[data-auth-tab]").forEach((button) => button.addEventListener("click", () => {
    mode = button.dataset.authTab;
    document.querySelectorAll("[data-auth-tab]").forEach((item) => item.classList.toggle("active", item === button));
    document.querySelector(".auth-name-field").hidden = mode !== "register";
    document.querySelector(".auth-district-field").hidden = mode !== "register";
    recoveryButton.hidden = mode !== "login";
    authFeedback.hidden = true;
    authFeedback.classList.remove("error");
    const passwordInput = document.querySelector("#auth-password");
    passwordInput.autocomplete = mode === "register" ? "new-password" : "current-password";
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
      await Promise.all([loadServerJobs(), loadServerApplications(), loadServerMessages(), loadServerProfile()]);
      connectMessageStream();
      switchView(action === "publish" && pageType === "Rapido" ? "anunciar" : "buscar");
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
    if (messageStream) {
      messageStream.close();
      messageStream = null;
    }
    currentUser = null;
    write(STORAGE.current, null);
    activeConversation = null;
    profile = null;
    accountButton.textContent = "Entrar";
    authDialog.close();
    switchView("buscar");
    showToast("Sesión cerrada.");
  });
}

document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
}));

async function loadServerJobs(silent = false) {
  try {
    const response = await fetch("/api/jobs");
    if (!response.ok) {
      if (!silent) showToast("No se pudieron cargar los trabajos. Inténtalo de nuevo.");
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
      applicantLimit: Number(job.applicant_limit || MAX_JOB_APPLICANTS),
      applicantCount: Number(job.applicant_count || 0),
      createdAt: job.created_at
    }));
    renderJobs();
  } catch {
    if (!silent) showToast("No se pudieron cargar los trabajos. Revisa tu conexión e inténtalo de nuevo.");
  }
}

async function restoreSecureSession() {
  try {
    const response = await fetch("/api/session");
    if (response.ok) {
      const result = await response.json();
      currentUser = result.user;
      write(STORAGE.current, currentUser);
      accountButton.textContent = currentUser.name.split(" ")[0];
      await Promise.all([loadServerApplications(), loadServerMessages(), loadServerProfile()]);
      connectMessageStream();
      switchView("buscar");
    } else {
      currentUser = null;
      profile = null;
      write(STORAGE.current, null);
      accountButton.textContent = "Entrar";
      switchView("buscar");
    }
  } catch {
    if (currentUser) {
      accountButton.textContent = currentUser.name.split(" ")[0];
      switchView("buscar");
    } else {
      switchView("buscar");
    }
  }
}

restoreSecureSession();
loadServerJobs();
loadServerMessages();
renderJobs();
renderConversations();
if (new URLSearchParams(window.location.search).get("login") === "1") {
  history.replaceState(null, "", window.location.pathname);
  openAuth("login");
}
window.setInterval(() => {
  if (currentUser && !document.hidden) loadServerMessages();
}, 5000);
window.setInterval(() => {
  const searchIsVisible = document.querySelector("#buscar-view").classList.contains("active");
  if (searchIsVisible && !document.hidden && !jobDialog.open) loadServerJobs(true);
}, 10000);
document.addEventListener("visibilitychange", () => {
  if (currentUser && !document.hidden) loadServerMessages();
});

if (new URLSearchParams(window.location.search).get("verified") === "1") {
  history.replaceState(null, "", window.location.pathname);
  showToast("Correo verificado. Ya puedes iniciar sesión.");
}
