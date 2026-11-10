// @wecommander/terminal-ui: the terminal view shared by the desktop app
// (copied to desktop/ui/terminal-view.js; CI checks the copy is identical)
// and, later, the web console. Needs xterm.js 5 and @xterm/addon-fit loaded
// as globals (window.Terminal, window.FitAddon).

const DARK = {
  background: "#111113", foreground: "#e4e4e7", cursor: "#60cdff", selectionBackground: "#3b82f655",
  black: "#18181b", red: "#f87171", green: "#4ade80", yellow: "#facc15", blue: "#60a5fa",
  magenta: "#c084fc", cyan: "#22d3ee", white: "#e4e4e7", brightBlack: "#52525b",
};

/**
 * Mounts a terminal in `element`.
 * - `onData(text)`: keystrokes and pastes to send to the remote shell.
 * - `onResize(cols, rows)`: the view changed size.
 * Returns { write(bytes|string), fit(), focus(), dispose(), cols, rows }.
 */
export function createTerminalView(element, { onData, onResize } = {}) {
  const term = new window.Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace',
    fontSize: 13,
    scrollback: 10000,
    theme: DARK,
    allowProposedApi: false,
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(element);
  const dataSub = term.onData((text) => onData && onData(text));
  const resizeSub = term.onResize(({ cols, rows }) => onResize && onResize(cols, rows));
  const observer = new ResizeObserver(() => {
    if (element.offsetParent !== null) {
      try { fit.fit(); } catch { /* hidden tab */ }
    }
  });
  observer.observe(element);
  try { fit.fit(); } catch { /* not visible yet */ }
  return {
    write(data) { term.write(data); },
    fit() { try { fit.fit(); } catch { /* hidden */ } },
    focus() { term.focus(); },
    dispose() { observer.disconnect(); dataSub.dispose(); resizeSub.dispose(); term.dispose(); },
    get cols() { return term.cols; },
    get rows() { return term.rows; },
  };
}
