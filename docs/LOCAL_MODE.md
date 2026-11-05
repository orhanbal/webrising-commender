# Local mode: WECOMMANDER without a gateway (MCP over stdio)

The same agent that connects your machines to the WECOMMANDER gateway can also
serve MCP directly to an AI client on the same computer: Claude Desktop,
Cursor, VS Code or any client that starts MCP servers as a local process. No
account, no gateway and no network connection are needed.

## Start it

```bash
webrising-commender mcp-stdio --allowed-root "$HOME/projects"
```

| Option | Default | Meaning |
|---|---|---|
| `--allowed-root <folder>` | required, repeatable | The only folders the tools may touch. Everything else is refused, including through symlinks. |
| `--allow-writes` | off | File writes: write, append, mkdir, move, replace, delete, undo. |
| `--allow-commands` | off | Commands, background tasks and terminals. |
| `--audit-log <file>` | none | Appends one JSON line per call: time, tool, risk, outcome. File contents are never written. |

Without `--allow-writes` and `--allow-commands`, the AI can read and search
only. With both, it behaves like Desktop Commander inside the allowed folders,
and still keeps undo snapshots for every write (`fs_versions`, `fs_undo`).

## Claude Desktop

Settings → Developer → Edit Config, then add:

```json
{
  "mcpServers": {
    "wecommander": {
      "command": "/opt/wecommander/bin/webrising-commender",
      "args": ["mcp-stdio", "--allowed-root", "/home/you/projects", "--allow-writes", "--audit-log", "/home/you/.wecommander-local.log"]
    }
  }
}
```

On Windows use the installed path (`C:\\Program Files\\WECOMMANDER\\webrising-commender.exe`)
and Windows folders. On macOS the binary is `/usr/local/bin/webrising-commender`.

## How it differs from remote mode

| | Local mode | Remote (gateway) mode |
|---|---|---|
| AI clients | local desktop clients that spawn a process | any MCP client, including claude.ai web, ChatGPT and mobile |
| Machines | this computer | every enrolled device, one MCP URL |
| High-risk approval | the flag you started it with | single-use approval per call in the browser, trust levels, allowlist |
| Audit | local file (`--audit-log`) | central audit log in the dashboard |
| Tools | the 40 device tools (generated from the gateway list) | the same, plus gateway tools (devices, url_fetch, edit_block, searches) |

The tool list is generated from the gateway's definitions
(`crates/agent/src/local_tools.json`, `npm run -s export-local-tools` in
`gateway/`), and a test fails if the two drift.
