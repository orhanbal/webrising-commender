# WECOMMANDER Windows Setup (preview)

The CI Windows acceptance artifact now builds a double-clickable Inno Setup installer named `WECOMMANDER-Setup-windows-x64.exe` in addition to the raw Rust agent. **Do not publish or call this release accepted until the installer job passes and a real Windows device completes end-to-end acceptance.**

## Installation

1. Download the `WECOMMANDER-windows-x64-acceptance` artifact from the current successful CI run and extract it.
2. Run `WECOMMANDER-Setup-windows-x64.exe`; Windows administrative consent is required to install to Program Files.
3. Leave **Connect my device** selected at the end of installation (or open **WECOMMANDER Cihaz Bağlantısı** in Start).
4. Enter your HTTPS control-plane URL, a **single-use pairing code** obtained from your own authorized WECOMMANDER workspace, and an existing allowed filesystem root.
5. The enrollment GUI runs in your normal Windows user context, saves the agent credential to that user's AppData, then requests UAC elevation to configure the native Windows service. Provide the **same user's** Windows credential to the elevated service helper. The password is handled as a PowerShell PSCredential; the installer never logs or writes it to disk.
6. Verify Windows Services lists `WebRisingCommender` as Running and the intended workspace reports the device online. Restart Windows and verify reconnect before accepting this installer.

## Limitations and security

- This is a guided GUI setup for a **background service agent**, not yet a full interactive tray/desktop management application.
- Use a dedicated low-privilege Windows account where possible. Do not use `-AllowLocalSystem` for regular installs. Grant that account access only to the selected allowed root.
- Service installation must be completed successfully; copying the EXE alone does **not** register any Windows service.
- The first-run GUI requires HTTPS, an existing directory, and a valid pairing code. Pairing codes must be treated as secrets.
- The service account must have permission to log on as a Windows service. Some managed Windows environments require a local administrator to grant this policy.
- To uninstall, use Windows Apps/Installed apps. The uninstall step stops/removes the service but intentionally leaves the agent's per-user configuration and credentials; revoke the device from your WECOMMANDER workspace if decommissioning it.

## Required release acceptance

- Inno Setup compiles on a real GitHub Windows runner, producing an EXE and SHA-256 checksum.
- Real Windows 10/11: GUI starts, UAC appears, service is installed, starts and survives reboot.
- Pairing, device online status, commands, files and persistent PTY/tasks function against the production gateway.
- Invalid pairing, denied elevation and invalid directory fail safely without silently creating a privileged service.
