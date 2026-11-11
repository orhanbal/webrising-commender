# wecommander-core protocol

`wecommander-core` is the WECOMMANDER app core (saved hosts, keyring, SSH
terminals, SFTP, jump hosts, tunnels) as a helper process. The native apps
(Windows WinUI 3, macOS SwiftUI) start it and talk to it over stdin/stdout. The
Linux app links the same code (`crates/wc-app-core`) directly.

```bash
wecommander-core --data-dir <app data folder> [--keyring-service app.wecommander]
```

One JSON object per line, UTF-8, in both directions.

| Direction | Shape |
|---|---|
| app → core | `{"id": 7, "method": "hosts.list", "params": {...}}` |
| core → app (reply) | `{"id": 7, "result": ...}` or `{"id": 7, "error": "text"}` |
| core → app (event) | `{"event": "terminal-output", "data": {...}}` |

Requests run concurrently: match replies by `id`. The first line is always the
`ready` event with the app info. Closing stdin ends the process and every SSH
connection.

## Methods

| Method | Params | Result |
|---|---|---|
| `app.info` | – | `{version, vaultBackend, vaultPersistent, os}` |
| `hosts.list` | – | `[Host]`: `{id, label, target, authKind, savedSecret, keyPath, jumpId, trustedKey, group, user, host, port}` |
| `hosts.add` | `label, host, port, user, authKind ("key"\|"password"), jumpId?` | `[Host]` |
| `hosts.delete` | `id` | `[Host]` (also forgets its secrets) |
| `hosts.import` | – | `{added, skipped, hosts:[Host]}` from `~/.ssh/config` |
| `secret.forget` | `id` | `[Host]` |
| `connect` | `id, auth, acceptFingerprint?, mode ("terminal"\|"test"), cols?, rows?` | `{status:"terminalOpened", sessionId, fingerprint}` · `{status:"connected", output, fingerprint}` · `{status:"hostKeyUnknown", algorithm, fingerprint}` · `{status:"hostKeyChanged", trusted, algorithm, fingerprint}` |
| `terminal.write` | `sessionId, data` (text) | `null` |
| `terminal.resize` | `sessionId, cols, rows` | `null` |
| `terminal.close` | `sessionId` | `null` |
| `files.list` | `sessionId, path?` (home when empty) | `{path, parent, entries:[{name, path, kind, size, modified, permissions}]}` |
| `files.download` | `sessionId, remote, local, transferId` | bytes |
| `files.upload` | `sessionId, local, remoteDir, transferId` | bytes |
| `files.mkdir` / `files.delete` | `sessionId, path` | `null` |
| `files.rename` | `sessionId, from, to` | `null` |
| `forward.start` | `sessionId, localPort (0 = free), remoteHost, remotePort` | `[{local, remote}]` |
| `forward.list` | `sessionId` | `[{local, remote}]` |
| `forward.stop` | `sessionId, local` | `[{local, remote}]` |
| `tunnels.saved` | – | `[{hostId, hostLabel, index, local, remote, running}]` |
| `tunnels.save` | `hostId, localPort, remoteHost, remotePort` | same list |
| `tunnels.delete` / `tunnels.toggle` | `hostId, index` | same list |
| `hosts.update` | `id, label, host, port, user, authKind, jumpId?, group?` | `[Host]` (a host is never its own jump host; loops are dropped) |
| `known.list` | – | `[{target ("host:port"), fingerprint, labels}]` trusted host keys |
| `known.forget` | `target` | same list; the next connect asks again |
| `snippets.list` | – | `[{id, label, command}]` saved commands |
| `snippets.save` | `id?, label, command` | same list (no `id`: new) |
| `snippets.delete` | `id` | same list |
| `history.list` / `history.clear` | – | `[{hostId, label, target, at}]`, newest first, at most 200 |
| `keys.list` | – | `[{id, label, algorithm, fingerprint, publicKey, created}]`; private keys stay in the OS keyring (`key/<id>/private`) |
| `keys.generate` | `label` | same list; a new Ed25519 key |
| `keys.import` | `label, private, passphrase?` | same list; the key is checked first |
| `keys.delete` | `id` | same list; hosts using it forget it |
| `hosts.setKey` | `id, keyId?` | `[Host]`; connect then uses that key (Host has `keyId`) |

`Host` = `{id, label, target, authKind, savedSecret, keyPath, jumpId, trustedKey}`.

`auth` = `{kind, secret, passphrase, remember, keyPath}`. An empty `secret` uses
the saved credential (keyring, or the host's key file). Show `hostKeyUnknown`
and `hostKeyChanged` to the person; resend `connect` with `acceptFingerprint`
only after they approve.

## Events

| Event | Data |
|---|---|
| `ready` | app info |
| `terminal-output` | `{sessionId, data}`: base64 bytes for the terminal view |
| `terminal-exit` | `{sessionId, code}` (`null` without exit status) |
| `transfer-progress` | `{transferId, done, total}` |
| `tunnels-changed` | – |
| `changed` | – hosts or saved tunnels changed (refresh lists and tray menus) |

Errors are short English texts with stable prefixes the apps map to their own
language (`no saved credential`, `authentication failed`, `key file `,
`jump host `, `did not start SFTP`, `cannot listen on`).

The end-to-end test `crates/wc-core-service/tests/sidecar.rs` drives the real
binary over this protocol against sshd (host key prompt, terminal, SFTP,
forward, exit status).
