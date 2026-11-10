// @wecommander/terminal-ui — V2 A01 skeleton.
// A03 replaces this with an xterm.js view (WebGL with canvas/DOM fallback,
// IME, copy/paste) after the G3 WebView performance gate.

/** Mounts a placeholder terminal view and returns a handle with write/dispose. */
export function createTerminalView(element) {
  const pre = document.createElement("pre");
  pre.className = "wc-terminal-placeholder";
  element.replaceChildren(pre);
  return {
    write(text) { pre.textContent += String(text); },
    dispose() { pre.remove(); },
  };
}
