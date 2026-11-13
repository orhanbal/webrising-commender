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
| `server.overview` | `sessionId` | `{hostname, os, kernel, uptimeSecs, load, cpus, cpuPercent, memTotalKb, memAvailableKb, swapTotalKb, swapFreeKb, disks:[{device, fsType, mount, sizeKb, usedKb, availKb}], rebootRequired, updates, processes, zombies, privilege, docker}`; `privilege` is `root`, `sudo` or empty (no changes possible) |
| `server.disk` | `sessionId, path?` (`/` when empty) | `{path, totalKb, entries:[{path, kb}], docker:[{kind, count, sizeBytes, reclaimableBytes}], complete}`; the 40 largest folders |
| `server.cleanupScan` | `sessionId` | `{items:[{id, title, detail, kb, command, warning}], privilege}`; fixed safe categories only |
| `server.cleanupRun` | `sessionId, ids` | `[{id, ok, message}]`; runs only the core's own command for each id |
| `server.processes` | `sessionId` | `{processes:[{pid, ppid, user, state, cpu, mem, rssKb, elapsedSecs, name, command}], zombies:[{parent, count, owner:{kind, id, name}, protected}], privilege}` |
| `server.signal` | `sessionId, pid, name, action` (`reap`, `term`, `kill`), `confirmDatabase?` | `""`; refused when `name` no longer matches, for system processes, and (error `database`) for databases until confirmed |
| `server.restartOwner` | `sessionId, kind` (`container`, `service`), `id` | `""`; never sshd, Docker itself or the agent |
| `files.download` | `sessionId, remote, local, transferId` | bytes |
| `files.upload` | `sessionId, local, remoteDir, transferId` | bytes |
| `files.mkdir` / `files.delete` | `sessionId, path` | `null` |
| `files.rename` | `sessionId, from, to` | `null` |
| `forward.start` | `sessionId, kind? (local\|remote\|dynamic, default local), localPort (0 = free), localHost? (remote only, default 127.0.0.1), remoteHost, remotePort` | `[{id, kind, local, remote}]`; local = `ssh -L`, remote = `ssh -R` (server listens on remoteHost:remotePort, 0 = server picks), dynamic = `ssh -D` SOCKS5 on 127.0.0.1 |
| `forward.list` | `sessionId` | `[{local, remote}]` |
| `forward.stop` | `sessionId, local` (the forward's `id`) | `[{local, remote}]` |
| `tunnels.saved` | – | `[{hostId, hostLabel, index, kind, local, remote, running}]` |
| `tunnels.save` | `hostId, kind?, localPort, localHost?, remoteHost, remotePort` (same fields as `forward.start`; ports fixed) | same list |
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
| `connect` auth extras | `installKey` (password logins) | after the login, this computer's app key ("WECOMMANDER <computer>", made once) is appended to the server's `~/.ssh/authorized_keys` and the host switches to it. With no saved credential a key host also tries `~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa` (unencrypted) and remembers the one that works |
| `hosts.setKey` | `id, keyId?` | `[Host]`; connect then uses that key (Host has `keyId`) |
| `hosts.setOptions` | `id, startupCommand?, env? ({NAME: value}), agentForwarding, sessionLog?` | `[Host]`; the terminal sends `env` (server `AcceptEnv` decides), types `startupCommand` once it opens, and with `agentForwarding` lets the server use this computer's ssh-agent (`ssh -A`) |
| `hosts.setConnection` | `id, protocol (ssh\|telnet\|serial\|mosh), serial? ({device, baud, dataBits, parity none\|even\|odd, stopBits, flow none\|hardware\|software})` | `[Host]` (Host has `protocol` and `serial`; `target` reads `telnet://host[:port]` or `COM3 · 9600 8N1`). Non-SSH hosts open with `connect` straight away (no auth, no host key); files and tunnels answer `files and tunnels work only on SSH terminals` |
| (SSH agent) | – | key logins also offer the keys of this computer's SSH agent in the same session after the host's own key is refused (Windows OpenSSH agent pipe, else `SSH_AUTH_SOCK`); hardware keys (FIDO2) sign there. A key host with nothing saved and no `~/.ssh` key file logs in with the agent alone (`auth.kind` `agent`) |
| `commands.add` | `hostId, command, prompt` | `null`; keeps a command typed in that host's terminal for autocomplete (last 500 per host, on this computer only: not in backups or sync). Lines typed after a password/passphrase/parola/token prompt are never kept |
| `commands.list` / `commands.clear` | `hostId` | that host's commands, newest last / `null` |
| `commands.suggest` | `hostId, prefix, limit?` | up to `limit` (5) completions: the host's own commands newest first, then snippets, then other hosts' |
| `logs.dir` | – | the session log folder (`<data dir>/logs`); a host with `sessionLog` writes each terminal to `<host>-<UTC date>.log` with colours and cursor moves removed |
| (Mosh) | – | a `mosh` host logs in with SSH (same credentials, no jump host), runs `mosh-server new -s -c 256 -l LANG=…` (en_US.UTF-8, then C.UTF-8), reads `MOSH CONNECT <port> <key>`, closes SSH and runs the terminal over UDP (SSP, AES-128-OCB). Closing the tab shuts `mosh-server` down; `exit` in the shell ends the terminal. With no UDP reply for 8 s the terminal prints a firewall hint (UDP 60000-61000) |
| `serial.ports` | – | `["COM3", ...]`: this computer's serial ports (no libudev on Linux, so the list can be short there) |
| `identities.list` | – | `[{id, label, user, authKind, keyId?}]` |
| `identities.save` | `id?, label, user, authKind (key\|password), keyId? (key), password? (password; empty keeps the stored one)` | same list; the password goes to the keyring (`identity/<id>/password`) |
| `identities.delete` | `id` | same list; hosts using it go back to their own credential |
| `hosts.setIdentity` | `id, identityId?` | `[Host]`; connect then uses the identity's user and credential (Host has `identityId`) |
| `sync.status` | – | `{configured, persistent}` (A20 sync between the user's computers) |
| `sync.setup` | `passphrase (≥ 8), remote? (the server's envelope)` | `{configured, persistent}`; derives the key (Argon2id, salt from `remote` or new), checks it against `remote`, keeps it in the keyring. Wrong passphrase: `wrong sync passphrase` |
| `sync.merge` | `remote?` (envelope from `GET /api/center/library`) | `{envelope?, changedHere}`; decrypts, merges three-way per item (hosts, snippets, identities, keys, trusted keys, keyring secrets), applies here, returns the AES-256-GCM envelope to `PUT` (none when the server already has it) |
| `sync.committed` | – | after the server accepted the `PUT`: the merged library becomes the base of the next merge |
| `sync.forget` | – | turns sync off on this computer |
| `team.status` | – | `{publicKey, hasKey}` (A22; this app's X25519 public key, made on first use) |
| `team.create` | – | `{sealed}`: a new team key sealed for this app (first app of a team) |
| `team.accept` | `sealed` | `{publicKey, hasKey}`: takes the team key another app sealed for this one |
| `team.share` | `publicKey` | `{sealed}`: the team key sealed for another team app |
| `team.merge` / `team.committed` | `remote?` / – | like `sync.merge` / `sync.committed`, for the hosts and snippets shared with the team (with their saved passwords); key files, app keys, identities and personal jump hosts stay with each computer |
| `team.seal` / `team.open` | `data` | `{data}`: A27 shared terminal frames sealed / opened with the team key (AES-256-GCM); the relay (`/center/share`) only sees sealed frames |
| `team.leave` | – | removed from the team: the team key and the shared items go |
| `library.setTeam` | `kind (host\|snippet), id, team` | `[Host]`; shares the item with the team or takes it back (Host and Snippet have `team`) |
| `library.export` | – | `{json}`: hosts (groups, tunnels, terminal options), snippets, trusted host keys; no passwords, no private keys, no key files |
| `library.import` | `json` | `{hosts, snippets, knownHosts, skipped}`; only adds what is new |

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
