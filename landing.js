const accountButton = document.querySelector("#account-button");
const accountDialog = document.querySelector("#account-dialog");
const quickProfilePhoto = document.querySelector("#quick-profile-photo");
const toast = document.querySelector("#toast");
let currentUser = null;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("visible"), 2800);
}

async function loadQuickProfilePhoto() {
  const response = await fetch("/api/profiles?type=Rapido");
  if (!response.ok) throw new Error("profile_load_failed");
  const result = await response.json();
  const profile = result.profile;
  if (profile?.photoData && profile.photoMime) {
    quickProfilePhoto.src = `data:${profile.photoMime};base64,${profile.photoData}`;
  }
}

function openAccount() {
  if (!currentUser) {
    window.location.href = "trabajorapido.html?login=1";
    return;
  }
  document.querySelector("#account-content").innerHTML = `
    <h2 id="account-dialog-title">Mi cuenta</h2>
    <p><strong id="account-name"></strong><br><span id="account-email"></span></p>
    <div class="dialog-actions"><button class="secondary-button" type="button" id="logout-button">Cerrar sesión</button></div>`;
  document.querySelector("#account-name").textContent = currentUser.name;
  document.querySelector("#account-email").textContent = currentUser.email;
  accountDialog.showModal();
  document.querySelector("#logout-button").addEventListener("click", async () => {
    try {
      const response = await fetch("/api/logout", { method: "POST" });
      if (!response.ok) throw new Error("logout_failed");
      currentUser = null;
      accountButton.textContent = "Entrar";
      quickProfilePhoto.src = "assets/no-profile.svg";
      accountDialog.close();
      showToast("Sesión cerrada.");
    } catch {
      showToast("No se pudo cerrar sesión. Inténtalo otra vez.");
    }
  });
}

accountButton.addEventListener("click", openAccount);
document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});
document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
});

fetch("/api/session")
  .then(async (response) => {
    if (!response.ok) return;
    const result = await response.json();
    currentUser = result.user;
    accountButton.textContent = currentUser.name.split(" ")[0];
    loadQuickProfilePhoto().catch(() => {
      showToast("No se pudo cargar la foto de perfil.");
    });
  })
  .catch(() => {});
