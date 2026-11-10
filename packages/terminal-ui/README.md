# @wecommander/terminal-ui

Terminal view shared by the WECOMMANDER desktop app (`desktop/`) and, later,
the web console: `createTerminalView(element, { onData, onResize })` returns
`{ write, fit, focus, dispose, cols, rows }`. It uses xterm.js 5 and
`@xterm/addon-fit` as globals (vendored in `desktop/ui/vendor/xterm`).

The desktop app serves a copy at `desktop/ui/terminal-view.js`; CI fails if the
copy and `src/index.js` differ.
