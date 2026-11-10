// WECOMMANDER desktop UI: saved hosts, connect dialog with host key
// approval, and terminal tabs (xterm.js via terminal-view.js).
import { createTerminalView } from "./terminal-view.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);

let hosts = [];
const sessions = new Map(); // sessionId -> { hostId, tab, pane, view, closed }
let activeSession = null;
let pending = null; // { host, auth, mode } waiting for host key approval

// ---- workspaces -----------------------------------------------------------
document.querySelectorAll(".ws").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".ws").forEach((b) => b.classList.toggle("active", b === button));
    $("ws-user").hidden = button.dataset.ws !== "user";
    $("ws-agent").hidden = button.dataset.ws !== "agent";
    if (button.dataset.ws === "user" && activeSession) sessions.get(activeSession)?.view.fit();
  });
});

// ---- host list ------------------------------------------------------------
function renderHosts(list) {
  hosts = list;
  $("hosts").replaceChildren(...list.map((h) => {
    const li = document.createElement("li");
    li.className = "host";
    li.tabIndex = 0;
    li.title = h.trustedKey ? `Sunucu anahtarı: ${h.trustedKey}` : "Sunucu anahtarı henüz onaylanmadı";
    const who = document.createElement("div");
    who.className = "who";
    const name = document.createElement("strong");
    name.textContent = h.label;
    const target = document.createElement("span");
    target.textContent = h.target;
    who.append(name, target);
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = h.savedSecret ? "🔑" : "";
    badge.title = h.savedSecret ? "Giriş bilgisi kasada kayıtlı" : "";
    const more = document.createElement("button");
    more.type = "button";
    more.className = "more";
    more.textContent = "⋯";
    more.setAttribute("aria-label", `${h.label} seçenekleri`);
    more.addEventListener("click", (e) => { e.stopPropagation(); openMenu(h, more); });
    li.append(who, badge, more);
    li.addEventListener("click", () => openTerminal(h));
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") openTerminal(h); });
    return li;
  }));
  $("empty").hidden = list.length > 0;
}

$("add-toggle").addEventListener("click", () => {
  const form = $("add-host");
  form.hidden = !form.hidden;
  $("add-toggle").setAttribute("aria-expanded", String(!form.hidden));
  if (!form.hidden) form.elements.label.focus();
});

$("add-host").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  $("add-error").textContent = "";
  try {
    renderHosts(await invoke("add_host", {
      label: form.elements.label.value, host: form.elements.host.value,
      port: Number(form.elements.port.value), user: form.elements.user.value,
      authKind: form.elements.authKind.value,
    }));
    form.reset();
    form.hidden = true;
    $("add-toggle").setAttribute("aria-expanded", "false");
  } catch (error) {
    $("add-error").textContent = String(error);
  }
});

let menu = null;
function closeMenu() { menu?.remove(); menu = null; }
document.addEventListener("click", closeMenu);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeMenu(); if (!$("dialog").hidden) closeDialog(); } });

function openMenu(host, anchor) {
  closeMenu();
  menu = document.createElement("div");
  menu.className = "menu";
  const item = (text, action, cls) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    if (cls) b.className = cls;
    b.addEventListener("click", (e) => { e.stopPropagation(); closeMenu(); action(); });
    menu.append(b);
  };
  item("Terminal aç", () => openTerminal(host));
  item("Bağlantıyı test et", () => startConnect(host, "test"));
  if (host.savedSecret) item("Kayıtlı giriş bilgisini unut", async () => renderHosts(await invoke("forget_secret", { id: host.id })));
  item("Sunucuyu sil", async () => {
    if (confirm(`${host.label} silinsin mi? Kasadaki giriş bilgisi de silinir.`)) renderHosts(await invoke("delete_host", { id: host.id }));
  }, "danger");
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, innerWidth - 200)}px`;
  menu.style.top = `${r.bottom + 4}px`;
  document.body.append(menu);
}

// ---- connect dialog -------------------------------------------------------
const form = $("connect");

function setStatus(text, isError = false) {
  $("connect-status").textContent = text;
  $("connect-status").classList.toggle("error", isError);
}

function syncKind() {
  const kind = form.elements.kind.value;
  form.elements.key.hidden = kind !== "key";
  form.elements.passphrase.hidden = kind !== "key";
  form.elements.password.hidden = kind !== "password";
}
form.addEventListener("change", (e) => { if (e.target.name === "kind") syncKind(); });

function openDialog(host, mode, message = "") {
  pending = { host, mode, auth: null };
  $("dialog").hidden = false;
  $("connect-title").textContent = `${host.label} · ${host.target}`;
  form.elements.kind.value = host.authKind;
  $("hostkey").hidden = true;
  $("connect-submit").hidden = false;
  setStatus(message, Boolean(message));
  syncKind();
  (host.authKind === "key" ? form.elements.key : form.elements.password).focus();
}

function closeDialog() {
  $("dialog").hidden = true;
  // Secrets stay in the form only while it is open.
  form.elements.key.value = form.elements.passphrase.value = form.elements.password.value = "";
  pending = null;
}
$("connect-cancel").addEventListener("click", closeDialog);

function typedAuth() {
  const kind = form.elements.kind.value;
  return {
    kind,
    secret: kind === "key" ? form.elements.key.value : form.elements.password.value,
    passphrase: kind === "key" ? form.elements.passphrase.value : null,
    remember: form.elements.remember.checked,
  };
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!pending) return;
  pending.auth = typedAuth();
  if (!pending.auth.secret) { setStatus(pending.auth.kind === "key" ? "Özel anahtarı yapıştır." : "Parolayı gir.", true); return; }
  runConnect(null);
});

$("hostkey-reject").addEventListener("click", () => { $("hostkey").hidden = true; setStatus("Bağlantı iptal edildi."); $("connect-submit").hidden = false; });
$("hostkey-accept").addEventListener("click", () => runConnect(pending?.fingerprint));

function openTerminal(host) { startConnect(host, "terminal"); }

/** Uses the saved credential when there is one, otherwise asks. */
function startConnect(host, mode) {
  if (!host.savedSecret) { openDialog(host, mode); return; }
  pending = { host, mode, auth: { kind: host.authKind, secret: "", passphrase: null, remember: false } };
  runConnect(null);
}

async function runConnect(acceptFingerprint) {
  const { host, mode, auth } = pending;
  const size = mode === "terminal" ? estimateSize() : {};
  if (!$("dialog").hidden) { setStatus("Bağlanıyor…"); $("hostkey").hidden = true; }
  try {
    const result = await invoke("connect_host", {
      id: host.id, auth, acceptFingerprint: acceptFingerprint ?? null, mode, ...size,
    });
    if (result.status === "hostKeyUnknown" || result.status === "hostKeyChanged") {
      showHostKey(host, mode, result);
      return;
    }
    closeDialog();
    renderHosts(await invoke("list_hosts"));
    if (result.status === "terminalOpened") addTerminal(host, result.sessionId);
    else alertToast(`${host.label}: bağlantı başarılı (${result.output}).`);
  } catch (error) {
    const text = String(error);
    if ($("dialog").hidden) openDialog(host, mode, readableError(text));
    else setStatus(readableError(text), true);
  }
}

function readableError(text) {
  if (text.includes("no saved credential")) return "Bu sunucu için kayıtlı giriş bilgisi yok; bir kez gir.";
  if (text.includes("authentication failed")) return "Giriş reddedildi. Anahtarı veya parolayı kontrol et.";
  if (text.includes("private key could not be used")) return "Özel anahtar okunamadı (biçim veya anahtar parolası yanlış).";
  if (text.includes("timed out")) return "Sunucu yanıt vermedi (zaman aşımı).";
  if (text.includes("connection failed")) return `Bağlanılamadı: ${text.replace("connection failed: ", "")}`;
  return text;
}

function showHostKey(host, mode, result) {
  if ($("dialog").hidden) {
    const auth = pending.auth;
    openDialog(host, mode);
    pending.auth = auth;
  }
  pending.fingerprint = result.fingerprint;
  const changed = result.status === "hostKeyChanged";
  $("hostkey").classList.toggle("danger", changed);
  $("hostkey-text").textContent = changed
    ? `UYARI: Bu sunucunun anahtarı değişti. Güvendiğin anahtar ${result.trusted} idi. Sunucuyu yeniden kurmadıysan bağlanma; araya biri girmiş olabilir.`
    : `Bu sunucuya ilk kez bağlanıyorsun. ${result.algorithm} anahtarının parmak izi aşağıda. Sunucu yöneticisinden aldığın değerle aynıysa güven.`;
  $("hostkey-fp").textContent = result.fingerprint;
  $("hostkey-accept").textContent = changed ? "Yeni anahtara yine de güven" : "Güven ve bağlan";
  $("hostkey").hidden = false;
  $("connect-submit").hidden = true;
  setStatus("");
}

let toastTimer = null;
function alertToast(text) {
  $("vault-note").textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(showVaultNote, 6000);
}

// ---- terminals ------------------------------------------------------------
function estimateSize() {
  const stack = $("term-stack");
  return { cols: Math.max(20, Math.floor((stack.clientWidth - 12) / 7.8)), rows: Math.max(6, Math.floor((stack.clientHeight - 8) / 17)) };
}

function addTerminal(host, sessionId) {
  $("welcome").hidden = true;
  const pane = document.createElement("div");
  pane.className = "term";
  $("term-stack").append(pane);
  const tab = document.createElement("div");
  tab.className = "tab";
  tab.setAttribute("role", "tab");
  const dot = document.createElement("span");
  dot.className = "dot";
  const name = document.createElement("span");
  name.textContent = host.label;
  const x = document.createElement("button");
  x.className = "x";
  x.type = "button";
  x.textContent = "×";
  x.setAttribute("aria-label", `${host.label} terminalini kapat`);
  tab.append(dot, name, x);
  $("tabs").append(tab);
  const session = { hostId: host.id, tab, pane, closed: false, view: null };
  sessions.set(sessionId, session);
  activate(sessionId);
  session.view = createTerminalView(pane, {
    onData: (text) => { if (!session.closed) invoke("terminal_write", { sessionId, data: text }).catch(() => {}); },
    onResize: (cols, rows) => { if (!session.closed) invoke("terminal_resize", { sessionId, cols, rows }).catch(() => {}); },
  });
  session.view.fit();
  invoke("terminal_resize", { sessionId, cols: session.view.cols, rows: session.view.rows }).catch(() => {});
  session.view.focus();
  tab.addEventListener("click", () => activate(sessionId));
  x.addEventListener("click", (e) => { e.stopPropagation(); closeTerminal(sessionId); });
}

function activate(sessionId) {
  activeSession = sessionId;
  for (const [id, s] of sessions) {
    s.pane.hidden = id !== sessionId;
    s.tab.classList.toggle("active", id === sessionId);
  }
  const s = sessions.get(sessionId);
  document.querySelectorAll(".host").forEach((li, i) => li.classList.toggle("active", hosts[i]?.id === s?.hostId));
  if (s?.view) { s.view.fit(); s.view.focus(); }
}

function closeTerminal(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (!s.closed) invoke("terminal_close", { sessionId }).catch(() => {});
  s.view?.dispose();
  s.pane.remove();
  s.tab.remove();
  sessions.delete(sessionId);
  const next = [...sessions.keys()].pop();
  if (next) activate(next);
  else { activeSession = null; $("welcome").hidden = false; }
}

const decoder = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
listen("terminal-output", ({ payload }) => sessions.get(payload.sessionId)?.view?.write(decoder(payload.data)));
listen("terminal-exit", ({ payload }) => {
  const s = sessions.get(payload.sessionId);
  if (!s) return;
  s.closed = true;
  s.tab.classList.add("closed");
  s.view?.write(`\r\n\x1b[90m[Bağlantı kapandı${payload.code != null ? `, çıkış kodu ${payload.code}` : ""}. Sekmeyi kapatabilirsin.]\x1b[0m\r\n`);
});

// ---- startup --------------------------------------------------------------
let info = null;
function showVaultNote() {
  if (!info) return;
  const note = $("vault-note");
  note.classList.toggle("warn", !info.vaultPersistent);
  note.textContent = info.vaultPersistent
    ? `Giriş bilgileri: ${info.vaultBackend}`
    : "Şifre kasası bulunamadı: giriş bilgileri uygulama kapanınca unutulur.";
  $("remember-label").textContent = info.vaultPersistent
    ? `Bu bilgisayarın şifre kasasında sakla (${info.vaultBackend})`
    : "Bu oturum boyunca hatırla";
}

(async () => {
  info = await invoke("app_info");
  $("meta").textContent = `v${info.version}`;
  $("meta").title = info.os;
  showVaultNote();
  renderHosts(await invoke("list_hosts"));
})();
