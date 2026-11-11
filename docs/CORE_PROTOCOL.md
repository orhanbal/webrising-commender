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
| `hosts.setKey` | `id, keyId?` | `[Host]`; connect then uses that key (Host has `keyId`) |
| `hosts.setOptions` | `id, startupCommand?, env? ({NAME: value}), agentForwarding` | `[Host]`; the terminal sends `env` (server `AcceptEnv` decides), types `startupCommand` once it opens, and with `agentForwarding` lets the server use this computer's ssh-agent (`ssh -A`) |
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
