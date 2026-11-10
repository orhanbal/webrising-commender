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

function renderHosts(hosts) {
  const list = $("hosts");
  list.replaceChildren(...hosts.map((h) => {
    const li = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = h.label;
    const target = document.createElement("span");
    target.textContent = h.target;
    li.append(name, target);
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

(async () => {
  const info = await invoke("app_info");
  $("meta").textContent = `v${info.version} · ${info.os}`;
  $("meta").title = `Kasa: ${info.vaultBackend} (planlanan: ${info.vaultPlanned})`;
  renderHosts(await invoke("list_hosts"));
})();
