// WECOMMANDER desktop (V2 A01 skeleton): workspace switch, app info and an
// in-session host list backed by wc-ssh-core validation.
const invoke = window.__TAURI__.core.invoke;
const $ = (id) => document.getElementById(id);

document.querySelectorAll(".ws").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".ws").forEach((b) => b.classList.toggle("active", b === button));
    $("ws-user").hidden = button.dataset.ws !== "user";
    $("ws-agent").hidden = button.dataset.ws !== "agent";
  });
});

let hostList = [];
let current = null; // { index, pendingFingerprint }

function renderHosts(hosts) {
  hostList = hosts;
  const list = $("hosts");
  list.replaceChildren(...hosts.map((h, index) => {
    const li = document.createElement("li");
    const text = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = h.label;
    const target = document.createElement("span");
    target.textContent = h.target;
    text.append(name, target);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Bağlan";
    button.addEventListener("click", () => openConnect(index));
    li.append(text, button);
    return li;
  }));
  $("empty").hidden = hosts.length > 0;
}

$("add-host").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  $("error").textContent = "";
  try {
    renderHosts(await invoke("add_host", {
      label: form.get("label"), host: form.get("host"),
      port: Number(form.get("port")), user: form.get("user"),
    }));
    event.target.reset();
  } catch (error) {
    $("error").textContent = String(error);
  }
});

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

function openConnect(index) {
  current = { index, pendingFingerprint: null };
  form.hidden = false;
  $("connect-title").textContent = `${hostList[index].label} · ${hostList[index].target}`;
  $("hostkey").hidden = true;
  $("connect-output").hidden = true;
  setStatus("");
  syncKind();
}

function closeConnect() {
  form.hidden = true;
  // Secrets live in the form only while it is open.
  form.elements.key.value = form.elements.passphrase.value = form.elements.password.value = "";
  current = null;
}

async function runConnect(acceptFingerprint) {
  const kind = form.elements.kind.value;
  const auth = kind === "key"
    ? { kind, secret: form.elements.key.value, passphrase: form.elements.passphrase.value }
    : { kind, secret: form.elements.password.value, passphrase: null };
  $("hostkey").hidden = true;
  $("connect-output").hidden = true;
  setStatus("Bağlanıyor…");
  try {
    const result = await invoke("test_connection", {
      index: current.index, auth, acceptFingerprint: acceptFingerprint ?? null,
    });
    if (result.status === "connected") {
      setStatus(`Bağlandı. Sunucu anahtarı: ${result.fingerprint}`);
      $("connect-output").textContent = result.output;
      $("connect-output").hidden = false;
      return;
    }
    current.pendingFingerprint = result.fingerprint;
    const box = $("hostkey");
    const changed = result.status === "hostKeyChanged";
    box.classList.toggle("danger", changed);
    $("hostkey-text").textContent = changed
      ? `UYARI: Bu sunucunun anahtarı değişti. Güvendiğin anahtar ${result.trusted} idi. Sunucuyu yeniden kurmadıysan bağlanma; araya biri girmiş olabilir.`
      : `Bu sunucuya ilk kez bağlanıyorsun. Sunucunun ${result.algorithm} anahtarının parmak izi aşağıda. Sunucu yöneticisinden aldığın değerle aynıysa güven.`;
    $("hostkey-fp").textContent = result.fingerprint;
    $("hostkey-accept").textContent = changed ? "Yeni anahtara yine de güven" : "Güven ve bağlan";
    box.hidden = false;
    setStatus("");
  } catch (error) {
    setStatus(String(error), true);
  }
}

form.addEventListener("change", (event) => { if (event.target.name === "kind") syncKind(); });
form.addEventListener("submit", (event) => { event.preventDefault(); runConnect(null); });
$("connect-cancel").addEventListener("click", closeConnect);
$("hostkey-reject").addEventListener("click", () => { $("hostkey").hidden = true; setStatus("Bağlantı iptal edildi."); });
$("hostkey-accept").addEventListener("click", () => runConnect(current.pendingFingerprint));

(async () => {
  const info = await invoke("app_info");
  $("meta").textContent = `v${info.version} · ${info.os}`;
  $("meta").title = `Kasa: ${info.vaultBackend} (planlanan: ${info.vaultPlanned})`;
  renderHosts(await invoke("list_hosts"));
})();
