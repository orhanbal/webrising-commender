// WECOMMANDER Management Center window. All gateway calls go through the
// app's Rust commands; this page never holds the center token.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
let state = null;
let tab = "approvals";
let minutes = 60;
let confirmId = null;
let busy = false;

const kinds = {
  process_exec: "Komut çalıştır",
  process_kill: "İşlemi sonlandır",
  task_start: "Arka plan görevi başlat",
  task_cancel: "Görevi iptal et",
  terminal_start: "Terminal aç",
  terminal_stop: "Terminali kapat",
  fs_delete: "Dosya sil",
  fs_move: "Dosya taşı",
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== false && value != null) node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children) if (child != null) node.append(child);
  return node;
}

function remaining(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "süresi doldu";
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
  return m >= 60 ? `${Math.round(m / 60)} sa` : m > 0 ? `${m} dk ${s} sn` : `${s} sn`;
}

function until(iso) {
  if (!iso) return "süresiz";
  return new Date(iso).toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" }) + "'e kadar";
}

function minutesToMorning() {
  const now = new Date();
  const target = new Date(now);
  target.setHours(9, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return Math.max(5, Math.round((target - now) / 60000));
}

function showError(message) {
  $("error").textContent = message || "";
  $("error").hidden = !message;
}

async function call(command, args) {
  if (busy) return null;
  busy = true;
  try {
    const next = await invoke(command, args);
    showError("");
    if (next && next.phase) render(next);
    return next;
  } catch (error) {
    showError(typeof error === "string" ? error : (error && error.message) || String(error));
    return null;
  } finally {
    busy = false;
  }
}

function renderPending() {
  const list = $("pendingList");
  list.replaceChildren();
  const items = state.pending;
  $("pendingEmpty").hidden = items.length > 0;
  $("pendingCount").hidden = items.length === 0;
  $("pendingCount").textContent = String(items.length);
  for (const item of items) {
    const expired = new Date(item.expiresAt).getTime() <= Date.now();
    const confirming = confirmId && confirmId.id === item.id;
    const actions = confirming
      ? el("div", { class: "row" },
          el("span", { class: "small" }, confirmId.approve ? "Yalnız bu işlem, bir kez." : "Yapay zekâ bunu çalıştıramaz."),
          el("button", { class: confirmId.approve ? "primary" : "danger", onclick: () => decide(item.id, confirmId.approve) },
            confirmId.approve ? "Evet, onayla" : "Evet, reddet"),
          el("button", { class: "ghost", onclick: () => { confirmId = null; renderPending(); } }, "Vazgeç"))
      : el("div", { class: "row" },
          el("button", { class: "primary", disabled: expired, onclick: () => { confirmId = { id: item.id, approve: true }; renderPending(); } }, "Onayla"),
          el("button", { class: "ghost", disabled: expired, onclick: () => { confirmId = { id: item.id, approve: false }; renderPending(); } }, "Reddet"));
    list.append(el("li", { class: "item" },
      el("div", { class: "meta" },
        el("strong", {}, item.deviceName),
        el("span", { class: "badge" }, kinds[item.kind] || item.kind),
        el("span", { class: "time", "data-expires": item.expiresAt }, remaining(item.expiresAt))),
      item.summary ? el("code", {}, item.summary) : null,
      actions));
  }
}

async function decide(id, approve) {
  confirmId = null;
  await call("decide", { id, approve });
}

function renderAutonomy() {
  const active = state.autonomy;
  $("autonomyActive").hidden = active.length === 0;
  $("autonomyList").replaceChildren(...active.map((d) => el("li", {}, `${d.name} · ${until(d.trustFullUntil)}`)));
  const box = $("scopeDevices");
  const checked = new Set([...box.querySelectorAll("input:checked")].map((i) => i.value));
  box.replaceChildren(...state.devices.map((d) =>
    el("label", { class: "inline" }, el("input", { type: "checkbox", value: d.id, checked: checked.has(d.id) }), ` ${d.name}`)));
  $("banner").hidden = active.length === 0;
  $("banner").textContent = active.length
    ? `Otonom mod açık: ${active.length} cihazda onay istenmiyor.`
    : "";
  updateStartButton();
}

function selectedDevices() {
  const scope = document.querySelector("input[name=scope]:checked").value;
  if (scope === "all") return null;
  return [...$("scopeDevices").querySelectorAll("input:checked")].map((i) => i.value);
}

function updateStartButton() {
  const devices = selectedDevices();
  $("startAutonomy").disabled = !$("password").value || (devices !== null && devices.length === 0);
}

function platformName(p) {
  return { windows: "Windows", macos: "macOS", linux: "Linux" }[p] || p || "";
}

function renderDevices() {
  const list = $("deviceList");
  $("devicesEmpty").hidden = state.devices.length > 0;
  list.replaceChildren(...state.devices.map((d) => el("li", { class: "item device" },
    el("span", { class: d.online ? "dot on" : "dot", title: d.online ? "Çevrimiçi" : "Çevrimdışı" }),
    el("div", {},
      el("strong", {}, d.name),
      el("div", { class: "small muted" },
        [platformName(d.platform), d.online ? "çevrimiçi" : "çevrimdışı",
         d.trustLevel === "full" ? `otonom (${until(d.trustFullUntil)})` : d.trustLevel === "strict" ? "sıkı" : "standart"]
          .filter(Boolean).join(" · "))))));
}

function render(next) {
  state = next;
  $("signedOut").hidden = state.phase !== "signedOut";
  $("linking").hidden = state.phase !== "linking";
  $("signedIn").hidden = state.phase !== "signedIn";
  if (state.error) showError(state.error);
  if (state.phase === "signedOut" && document.activeElement !== $("server")) $("server").value = state.server;
  const me = state.me;
  $("who").textContent = state.phase === "signedIn" && me
    ? `${me.email || ""}${me.organizationName ? " · " + me.organizationName : ""}`
    : "";
  if (state.phase === "signedIn") {
    renderPending();
    renderAutonomy();
    renderDevices();
    $("setNotify").checked = state.settings.notifications;
    $("setOpen").checked = state.settings.openOnRequest;
    $("setAutostart").checked = state.autostart;
    $("about").textContent = `Sürüm ${state.version}${me ? " · bu merkez: " + me.name : ""} · ${state.server}`;
  } else {
    $("banner").hidden = true;
  }
  $("status").textContent = state.phase === "signedIn"
    ? (state.syncedSecondsAgo == null ? "Eşitleniyor…" : `Son eşitleme: ${state.syncedSecondsAgo} sn önce`)
    : "";
}

function selectTab(name) {
  tab = name;
  for (const button of document.querySelectorAll(".tabs button")) button.classList.toggle("active", button.dataset.tab === name);
  for (const panel of document.querySelectorAll(".tab")) panel.hidden = panel.id !== "tab-" + name;
}

document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));
$("connect").addEventListener("click", () => call("connect", { server: $("server").value, name: $("centerName").value }));
$("openLink").addEventListener("click", () => invoke("open_link").catch((e) => showError(String(e))));
$("cancelLink").addEventListener("click", () => call("cancel_connect"));
document.querySelectorAll("input[name=scope]").forEach((r) => r.addEventListener("change", () => {
  $("scopeDevices").hidden = selectedDevices() === null;
  updateStartButton();
}));
$("scopeDevices").addEventListener("change", updateStartButton);
$("password").addEventListener("input", updateStartButton);
$("durations").addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  document.querySelectorAll("#durations .chip").forEach((c) => c.classList.toggle("active", c === chip));
  minutes = chip.dataset.minutes === "morning" ? "morning" : chip.dataset.minutes === "" ? null : Number(chip.dataset.minutes);
});
$("startAutonomy").addEventListener("click", async () => {
  const value = minutes === "morning" ? minutesToMorning() : minutes;
  const ok = await call("autonomy_start", { minutes: value, deviceIds: selectedDevices(), password: $("password").value });
  if (ok) $("password").value = "";
  updateStartButton();
});
$("stopAll").addEventListener("click", () => call("autonomy_stop", { deviceIds: null }));
$("setNotify").addEventListener("change", () => call("set_settings", { notifications: $("setNotify").checked, openOnRequest: $("setOpen").checked }));
$("setOpen").addEventListener("change", () => call("set_settings", { notifications: $("setNotify").checked, openOnRequest: $("setOpen").checked }));
$("setAutostart").addEventListener("change", () => call("set_autostart", { enabled: $("setAutostart").checked }));
$("openDashboard").addEventListener("click", () => invoke("open_dashboard", { page: null }));
$("disconnect").addEventListener("click", () => {
  if (window.confirm("Bu bilgisayarın Yönetim Merkezi bağlantısı kesilsin mi? Yeniden bağlanmak için tarayıcıda onay gerekir.")) call("disconnect");
});

// Countdown text updates without a round trip.
setInterval(() => {
  for (const node of document.querySelectorAll("[data-expires]")) node.textContent = remaining(node.dataset.expires);
}, 1000);

(async () => {
  $("centerName").value = await invoke("default_name");
  render(await invoke("get_state"));
  await listen("state", (event) => render(event.payload));
})();
