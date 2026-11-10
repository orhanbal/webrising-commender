// WECOMMANDER desktop UI: saved hosts, connect dialog with host key
// approval, and terminal tabs (xterm.js via terminal-view.js).
import { createTerminalView } from "./terminal-view.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const clipboard = window.__TAURI__.clipboardManager;
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
    if (button.dataset.ws === "agent") refreshAgent();
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
    const jump = h.jumpId && list.find((j) => j.id === h.jumpId);
    if (jump) { const via = document.createElement("span"); via.className = "via"; via.textContent = `↪ ${jump.label} üzerinden`; who.append(via); }
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
  const select = $("add-host").elements.jumpId;
  const keep = select.value;
  select.replaceChildren(new Option("Doğrudan bağlan", ""), ...list.map((h) => new Option(`${h.label} üzerinden (atlama sunucusu)`, h.id)));
  select.value = list.some((h) => h.id === keep) ? keep : "";
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
      jumpId: form.elements.jumpId.value || null,
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
    if (await ask({ title: `${host.label} silinsin mi?`, text: "Kasadaki giriş bilgisi de silinir.", ok: "Sil" }) !== null) renderHosts(await invoke("delete_host", { id: host.id }));
  }, "danger");
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, innerWidth - 200)}px`;
  menu.style.top = `${r.bottom + 4}px`;
  document.body.append(menu);
}

// ---- small question dialog (window.prompt/confirm are unreliable in webviews)
/** Resolves to the entered text (or "" without an input), null on cancel. */
function ask({ title, text = "", value = null, ok = "Tamam" }) {
  return new Promise((resolve) => {
    const overlay = $("ask"), formEl = $("ask-form"), input = $("ask-input");
    $("ask-title").textContent = title;
    $("ask-text").textContent = text;
    $("ask-ok").textContent = ok;
    input.hidden = value === null;
    input.value = value ?? "";
    overlay.hidden = false;
    (value === null ? $("ask-ok") : input).focus();
    if (value !== null) input.select();
    const done = (result) => {
      overlay.hidden = true;
      formEl.onsubmit = null; $("ask-cancel").onclick = null; overlay.onkeydown = null;
      resolve(result);
    };
    formEl.onsubmit = (e) => { e.preventDefault(); done(value === null ? "" : input.value.trim()); };
    $("ask-cancel").onclick = () => done(null);
    overlay.onkeydown = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(null); } };
  });
}

// ---- connect dialog -------------------------------------------------------
const form = $("connect");

function setStatus(text, isError = false) {
  $("connect-status").textContent = text;
  $("connect-status").classList.toggle("error", isError);
}

function syncKind() {
  const kind = form.elements.kind.value;
  form.elements.key.hidden = kind !== "key" || Boolean(pickedKeyPath);
  $("keyfile-row").hidden = kind !== "key";
  form.elements.passphrase.hidden = kind !== "key";
  form.elements.password.hidden = kind !== "password";
}
form.addEventListener("change", (e) => { if (e.target.name === "kind") syncKind(); });

let pickedKeyPath = null;
function showKeyPath(path) {
  pickedKeyPath = path;
  $("keyfile-path").textContent = path || "ya da anahtarı aşağıya yapıştır";
  form.elements.key.hidden = Boolean(path) || form.elements.kind.value !== "key";
}

function openDialog(host, mode, message = "") {
  pending = { host, mode, auth: null };
  showKeyPath(host.keyPath || null);
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
  pickedKeyPath = null;
}
$("connect-cancel").addEventListener("click", closeDialog);

function typedAuth() {
  const kind = form.elements.kind.value;
  return {
    kind,
    secret: kind === "key" ? form.elements.key.value : form.elements.password.value,
    passphrase: kind === "key" ? form.elements.passphrase.value : null,
    remember: form.elements.remember.checked,
    keyPath: kind === "key" && pickedKeyPath && !form.elements.key.value ? pickedKeyPath : null,
  };
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!pending) return;
  pending.auth = typedAuth();
  if (!pending.auth.secret && !pending.auth.keyPath) { setStatus(pending.auth.kind === "key" ? "Özel anahtarı yapıştır." : "Parolayı gir.", true); return; }
  runConnect(null);
});

$("hostkey-reject").addEventListener("click", () => { $("hostkey").hidden = true; setStatus("Bağlantı iptal edildi."); $("connect-submit").hidden = false; });
$("hostkey-accept").addEventListener("click", () => runConnect(pending?.fingerprint));

function openTerminal(host) { startConnect(host, "terminal"); }

/** Uses the saved credential or key file when there is one, otherwise asks. */
function startConnect(host, mode) {
  if (!host.savedSecret && !(host.authKind === "key" && host.keyPath)) { openDialog(host, mode); return; }
  pending = { host, mode, auth: { kind: host.authKind, secret: "", passphrase: null, remember: false, keyPath: null } };
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
    const needsCredential = /no saved credential|authentication failed|private key could not be used|key file /.test(text);
    if (!$("dialog").hidden) setStatus(readableError(text), true);
    else if (needsCredential) openDialog(host, mode, readableError(text));
    else { pending = null; alertToast(`${host.label}: ${readableError(text)}`); }
  }
}

function readableError(text) {
  if (text.includes("no saved credential")) return "Bu sunucu için kayıtlı giriş bilgisi yok; bir kez gir.";
  if (text.includes("authentication failed")) return "Giriş reddedildi. Anahtarı veya parolayı kontrol et.";
  if (text.includes("jump host ")) return `Atlama sunucusu: ${text.replace(/^.*jump host /, "")}`;
  if (text.includes("key file ")) return `Anahtar dosyası okunamadı: ${text.replace(/^key file /, "")}`;
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
    clipboard,
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
  syncFilesButton();
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
  else { activeSession = null; $("welcome").hidden = false; syncFilesButton(); }
}

const decoder = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
listen("terminal-output", ({ payload }) => sessions.get(payload.sessionId)?.view?.write(decoder(payload.data)));
listen("terminal-exit", ({ payload }) => {
  const s = sessions.get(payload.sessionId);
  if (!s) return;
  s.closed = true;
  s.tab.classList.add("closed");
  if (payload.sessionId === activeSession) syncFilesButton();
  s.view?.write(`\r\n\x1b[90m[Bağlantı kapandı${payload.code != null ? `, çıkış kodu ${payload.code}` : ""}. Sekmeyi kapatabilirsin.]\x1b[0m\r\n`);
});

$("keyfile-pick").addEventListener("click", async () => {
  const path = await window.__TAURI__.dialog.open({ multiple: false, directory: false, title: "Özel anahtar dosyası (ör. ~/.ssh/id_ed25519)" });
  if (path) showKeyPath(Array.isArray(path) ? path[0] : path);
});

$("import-config").addEventListener("click", async () => {
  try {
    const result = await invoke("import_ssh_config");
    renderHosts(result.hosts);
    alertToast(result.added ? `${result.added} sunucu içe aktarıldı${result.skipped ? `, ${result.skipped} zaten vardı` : ""}.` : "Yeni sunucu bulunamadı.");
  } catch (error) {
    alertToast(`~/.ssh/config okunamadı: ${error}`);
  }
});

// ---- file manager (SFTP, A09) ----------------------------------------------
const { save: saveDialog, open: openDialogFiles } = window.__TAURI__.dialog;
let filesOpen = false;

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
function fmtTime(secs) {
  return secs ? new Date(secs * 1000).toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" }) : "";
}

function syncFilesButton() {
  const s = activeSession && sessions.get(activeSession);
  $("files-toggle").disabled = !s || s.closed;
  $("tunnels-toggle").disabled = !s || s.closed;
  $("files-toggle").setAttribute("aria-pressed", String(filesOpen && !!s));
  $("files").hidden = !(filesOpen && s && !s.closed);
  if (!$("files").hidden) loadFiles(s.files?.path ?? null);
  sessions.get(activeSession)?.view?.fit();
}

$("files-toggle").addEventListener("click", () => { filesOpen = !filesOpen; syncFilesButton(); });

async function loadFiles(path) {
  const sessionId = activeSession;
  const s = sessions.get(sessionId);
  if (!s) return;
  const list = $("file-list");
  try {
    const listing = await invoke("files_list", { sessionId, path });
    if (sessionId !== activeSession) return;
    s.files = listing;
    $("files-path").value = listing.path;
    list.replaceChildren(...listing.entries.map((e) => fileRow(sessionId, e)));
    if (!listing.entries.length) {
      const li = document.createElement("li");
      li.className = "files-error"; li.style.color = "var(--muted)"; li.textContent = "Bu klasör boş.";
      list.append(li);
    }
  } catch (error) {
    const li = document.createElement("li");
    li.className = "files-error";
    li.textContent = String(error).includes("did not start SFTP")
      ? "Bu sunucu SFTP'yi açmadı. sshd_config içinde 'Subsystem sftp' satırı olmalı."
      : `Klasör açılamadı: ${error}`;
    list.replaceChildren(li);
  }
}

function fileRow(sessionId, e) {
  const li = document.createElement("li");
  li.className = `file ${e.kind}`;
  li.tabIndex = 0;
  li.title = `${e.permissions}  ${e.path}`;
  const ico = document.createElement("span"); ico.className = "ico";
  ico.textContent = e.kind === "dir" ? "📁" : e.kind === "link" ? "🔗" : "📄";
  const name = document.createElement("span"); name.className = "name"; name.textContent = e.name;
  const meta = document.createElement("span"); meta.className = "meta";
  meta.textContent = e.kind === "dir" ? fmtTime(e.modified) : `${fmtSize(e.size)} · ${fmtTime(e.modified)}`;
  const acts = document.createElement("span"); acts.className = "acts";
  const btn = (text, fn, cls) => { const b = document.createElement("button"); b.type = "button"; b.textContent = text; if (cls) b.className = cls; b.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); }); acts.append(b); };
  if (e.kind !== "dir") btn("İndir", () => download(sessionId, e));
  btn("Ad", () => renameEntry(sessionId, e));
  btn("Sil", () => deleteEntry(sessionId, e), "danger");
  li.append(ico, name, meta, acts);
  const openDir = () => { if (e.kind === "dir" || e.kind === "link") loadFiles(e.path); };
  li.addEventListener("dblclick", openDir);
  name.addEventListener("click", () => { if (e.kind === "dir") openDir(); });
  li.addEventListener("keydown", (ev) => { if (ev.key === "Enter") openDir(); });
  return li;
}

$("files-up").addEventListener("click", () => { const s = sessions.get(activeSession); if (s?.files) loadFiles(s.files.parent); });
$("files-refresh").addEventListener("click", () => loadFiles(sessions.get(activeSession)?.files?.path ?? null));
$("files-path").addEventListener("keydown", (e) => { if (e.key === "Enter") loadFiles(e.target.value.trim() || null); });

$("files-mkdir").addEventListener("click", async () => {
  const s = sessions.get(activeSession); if (!s?.files) return;
  const name = await ask({ title: "Yeni klasör", text: s.files.path, value: "", ok: "Oluştur" });
  if (!name) return;
  try { await invoke("files_mkdir", { sessionId: activeSession, path: joinPath(s.files.path, name) }); loadFiles(s.files.path); }
  catch (error) { transferNote(`Klasör oluşturulamadı: ${error}`, "err"); }
});

async function renameEntry(sessionId, e) {
  const name = await ask({ title: "Yeniden adlandır", text: e.path, value: e.name, ok: "Kaydet" });
  if (!name || name === e.name) return;
  const dir = sessions.get(sessionId)?.files?.path;
  try { await invoke("files_rename", { sessionId, from: e.path, to: joinPath(dir, name) }); loadFiles(dir); }
  catch (error) { transferNote(`Yeniden adlandırılamadı: ${error}`, "err"); }
}

async function deleteEntry(sessionId, e) {
  const sure = await ask({ title: `${e.name} silinsin mi?`, text: e.kind === "dir" ? "Yalnızca boş klasörler silinebilir." : "Bu işlem geri alınamaz.", ok: "Sil" });
  if (sure === null) return;
  const dir = sessions.get(sessionId)?.files?.path;
  try { await invoke("files_delete", { sessionId, path: e.path }); loadFiles(dir); }
  catch (error) { transferNote(`Silinemedi: ${error}`, "err"); }
}

function joinPath(dir, name) { return dir.endsWith("/") ? dir + name : `${dir}/${name}`; }

const transfers = new Map();
function transferRow(label) {
  const id = crypto.randomUUID();
  const row = document.createElement("div"); row.className = "transfer";
  const text = document.createElement("div"); text.textContent = label;
  const bar = document.createElement("div"); bar.className = "bar"; const fill = document.createElement("i"); bar.append(fill);
  row.append(text, bar);
  $("transfers").prepend(row);
  transfers.set(id, { row, text, fill, label });
  return id;
}
function finishTransfer(id, ok, message) {
  const t = transfers.get(id); if (!t) return;
  t.row.classList.add(ok ? "ok" : "err");
  t.text.textContent = message;
  t.fill.style.width = ok ? "100%" : t.fill.style.width;
  setTimeout(() => { t.row.remove(); transfers.delete(id); }, ok ? 4000 : 12000);
}
function transferNote(message, cls) {
  const id = transferRow(message);
  finishTransfer(id, cls !== "err", message);
}
listen("transfer-progress", ({ payload }) => {
  const t = transfers.get(payload.transferId); if (!t) return;
  const pct = payload.total ? Math.round((payload.done / payload.total) * 100) : 100;
  t.fill.style.width = `${pct}%`;
  t.text.textContent = `${t.label} · ${fmtSize(payload.done)} / ${fmtSize(payload.total)}`;
});

async function download(sessionId, e) {
  const local = await saveDialog({ defaultPath: e.name, title: "Nereye kaydedilsin?" });
  if (!local) return;
  const transferId = transferRow(`⬇ ${e.name}`);
  try { const n = await invoke("files_download", { sessionId, remote: e.path, local, transferId }); finishTransfer(transferId, true, `⬇ ${e.name} indirildi (${fmtSize(n)})`); }
  catch (error) { finishTransfer(transferId, false, `⬇ ${e.name}: ${error}`); }
}

async function uploadPaths(paths) {
  const sessionId = activeSession;
  const dir = sessions.get(sessionId)?.files?.path;
  if (!dir) return;
  for (const local of paths) {
    const name = local.split(/[\\/]/).pop();
    const transferId = transferRow(`⬆ ${name}`);
    try { const n = await invoke("files_upload", { sessionId, local, remoteDir: dir, transferId }); finishTransfer(transferId, true, `⬆ ${name} yüklendi (${fmtSize(n)})`); }
    catch (error) { finishTransfer(transferId, false, `⬆ ${name}: ${error}`); }
  }
  if (sessionId === activeSession) loadFiles(dir);
}

$("files-upload").addEventListener("click", async () => {
  const picked = await openDialogFiles({ multiple: true, directory: false, title: "Yüklenecek dosyalar" });
  if (picked) uploadPaths(Array.isArray(picked) ? picked : [picked]);
});

window.__TAURI__.webview.getCurrentWebview().onDragDropEvent(({ payload }) => {
  const panel = $("files");
  if (panel.hidden) return;
  if (payload.type === "enter" || payload.type === "over") panel.classList.add("drop");
  else panel.classList.remove("drop");
  if (payload.type === "drop" && payload.paths?.length) uploadPaths(payload.paths);
});

// ---- tunnels (A10, ssh -L) -------------------------------------------------
function renderTunnels(list) {
  const sessionId = activeSession;
  $("tunnel-list").replaceChildren(...list.map((t) => {
    const li = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = `${t.local}  →  ${t.remote}`;
    const stop = document.createElement("button");
    stop.type = "button"; stop.textContent = "Kapat";
    stop.addEventListener("click", async () => renderTunnels(await invoke("forward_stop", { sessionId, local: t.local })));
    li.append(text, stop);
    return li;
  }));
  const s = sessions.get(sessionId);
  if (s) s.tab.title = list.length ? `${list.length} tünel açık` : "";
}

$("tunnels-toggle").addEventListener("click", async () => {
  if (!activeSession) return;
  $("tunnel-status").textContent = "";
  $("tunnels").hidden = false;
  try { renderTunnels(await invoke("forward_list", { sessionId: activeSession })); } catch (e) { $("tunnel-status").textContent = String(e); }
  $("tunnel-form").elements.localPort.focus();
});
$("tunnel-close").addEventListener("click", () => { $("tunnels").hidden = true; });
$("tunnels").addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); $("tunnels").hidden = true; } });
$("tunnel-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const f = event.target.elements;
  $("tunnel-status").classList.remove("error");
  try {
    const list = await invoke("forward_start", {
      sessionId: activeSession, localPort: Number(f.localPort.value || 0),
      remoteHost: f.remoteHost.value, remotePort: Number(f.remotePort.value),
    });
    renderTunnels(list);
    const opened = list[list.length - 1];
    $("tunnel-status").textContent = `Açıldı: ${opened.local} adresine bağlan.`;
    f.localPort.value = ""; f.remotePort.value = "";
  } catch (error) {
    $("tunnel-status").classList.add("error");
    $("tunnel-status").textContent = String(error).replace("cannot listen on", "Port dinlenemiyor:");
  }
});

// ---- Agent Mode (B09) ------------------------------------------------------
let agentTimer = null;
// Same labels as the Management Center (tray/ui/app.js).
const KIND = {
  process_exec: "Komut çalıştır", process_kill: "İşlemi sonlandır", task_start: "Arka plan görevi başlat",
  task_cancel: "Görevi iptal et", terminal_start: "Terminal aç", terminal_stop: "Terminali kapat",
  terminal_input: "Terminale yaz", fs_delete: "Dosya sil", fs_move: "Dosya taşı",
};

async function refreshAgent() {
  clearTimeout(agentTimer);
  $("agent-error").textContent = "";
  try {
    const status = await invoke("agent_status");
    $("agent-link").hidden = status.linked;
    $("agent-main").hidden = !status.linked;
    $("agent-unlink").hidden = !status.linked;
    if (!status.linked) {
      $("agent-who").textContent = "WECOMMANDER hesabın: cihazların ve yapay zekânın onay bekleyen işlemleri.";
      if (!status.keyring) $("agent-link-status").textContent = "Uyarı: şifre kasası yok; bağlantı uygulama kapanınca unutulur.";
      return;
    }
    const me = status.me;
    $("agent-who").textContent = `${me.email ?? me.name} · ${me.organizationName ?? ""} · ${me.role}`;
    const overview = await invoke("agent_overview");
    renderApprovals(overview.pending);
    renderDevices(overview.devices);
  } catch (error) {
    $("agent-error").textContent = String(error);
  } finally {
    if (!$("ws-agent").hidden) agentTimer = setTimeout(refreshAgent, 5000);
  }
}

function renderApprovals(items) {
  $("pending-count").textContent = items.length;
  $("approvals-empty").hidden = items.length > 0;
  $("approvals").replaceChildren(...items.map((a) => {
    const li = document.createElement("li");
    li.className = "approval";
    const who = document.createElement("div");
    who.className = "who";
    const left = Math.max(0, Math.round((new Date(a.expiresAt) - Date.now()) / 60000));
    who.textContent = `${KIND[a.kind] ?? a.kind} · ${a.device} · ${left} dk içinde düşer`;
    const code = document.createElement("code");
    code.textContent = a.summary || "(ayrıntı yok)";
    const acts = document.createElement("div");
    acts.className = "acts";
    const yes = document.createElement("button"); yes.className = "primary"; yes.textContent = "Onayla";
    const no = document.createElement("button"); no.className = "deny"; no.textContent = "Reddet";
    const decide = async (approve) => {
      yes.disabled = no.disabled = true;
      try { await invoke("agent_decide", { id: a.id, approve }); }
      catch (error) { $("agent-error").textContent = String(error); }
      refreshAgent();
    };
    yes.addEventListener("click", () => decide(true));
    no.addEventListener("click", () => decide(false));
    acts.append(yes, no);
    li.append(who, acts, code);
    return li;
  }));
}

function renderDevices(items) {
  const names = { windows: "Windows", macos: "macOS", linux: "Linux" };
  $("devices").replaceChildren(...items.map((d) => {
    const li = document.createElement("li");
    li.className = `device${d.online ? " on" : ""}`;
    const dot = document.createElement("span"); dot.className = "dot";
    const name = document.createElement("strong"); name.textContent = d.name;
    const state = document.createElement("span"); state.className = "muted small"; state.textContent = d.online ? "çevrimiçi" : "çevrimdışı";
    const plat = document.createElement("span"); plat.className = "plat"; plat.textContent = names[d.platform] ?? d.platform ?? "";
    li.append(dot, name, state, plat);
    return li;
  }));
}

$("agent-link-start").addEventListener("click", async () => {
  $("agent-link-status").textContent = "Bağlantı isteği oluşturuluyor…";
  try {
    const start = await invoke("agent_link_start");
    await window.__TAURI__.opener.openUrl(start.approveUrl);
    $("agent-link-status").textContent = "Tarayıcıda onayla; bu ekran kendiliğinden güncellenecek.";
  } catch (error) {
    $("agent-link-status").textContent = `Başlatılamadı: ${error}`;
  }
});
listen("agent-linked", () => { $("agent-link-status").textContent = ""; refreshAgent(); });
listen("agent-link-failed", ({ payload }) => {
  $("agent-link-status").textContent = payload === "expired" ? "Bağlantı isteğinin süresi doldu; yeniden dene." : `Bağlanamadı: ${payload}`;
});
$("agent-unlink").addEventListener("click", async () => {
  if (await ask({ title: "Hesap bağlantısı kesilsin mi?", text: "Bu bilgisayar onay bekleyenleri artık göstermez.", ok: "Bağlantıyı kes" }) === null) return;
  await invoke("agent_unlink");
  refreshAgent();
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
