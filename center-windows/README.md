# WECOMMANDER Management Center for Windows (WinUI 3)

Native Windows tray app for approvals and autonomous mode. Same gateway API
as the cross-platform Tauri tray (`tray/`), which stays for macOS and Linux.

- `Core/`: gateway client, settings, Turkish texts (net8.0, any OS)
- `Core.Tests/`: `dotnet test center-windows/Core.Tests`
- `App/`: WinUI 3 app, unpackaged and self-contained (Windows App SDK
  included): tray icon (H.NotifyIcon), right-edge acrylic panel, Windows
  notifications with Onayla / Reddet (AppNotifications), sign in through the
  browser, token encrypted with DPAPI, start with Windows (HKCU Run).

Build (Windows): `dotnet publish center-windows/App/WecommanderCenter.csproj -c Release -r win-x64 --self-contained true -p:Platform=x64 -o publish`

Install: `irm https://wecommander.app/install.ps1 | iex`, or the panel's
`WECOMMANDER-Kur.cmd` (same command; `-Tauri` for the earlier tray app).
Per user, no administrator rights; downloaded by PowerShell, so no
SmartScreen warning for the app.

## One app, agent inside

The publish folder carries `webrising-commender.exe` (the agent) and
`build.txt` (the CI run number N; the agent reports 0.1.N).

- After the browser sign-in the app asks the gateway for a one-time pairing
  code and runs `webrising-commender --config %APPDATA%\webrising-commender\agent.json
  enroll …` hidden. An existing pairing is kept as `agent.json.bak` until the
  new one works.
- The app runs `webrising-commender --config … run` as a hidden child process
  (`CreateNoWindow`): no scheduled task, no console window. A watchdog
  restarts it (0 s, 30 s, 2 min, then a notification). Quitting from the tray
  stops it; the app starts with Windows (HKCU Run).
- First start after an older install: the per-user scheduled task is deleted,
  old agent processes are stopped, and what needs admin (an elevated task,
  the legacy service, the Program Files setup) is removed with one UAC prompt,
  once. The pairing is kept.
- "Uygulamayı güncelle": newest `ubuntu-preview-N` with the app zip, checked
  against `SHA256SUMS.txt`, unpacked next to the app and swapped in by a
  hidden PowerShell helper after the app quits; the app starts again.
- Builds without the agent next to them keep the earlier behaviour
  (separately installed agent, `AgentControl`).
