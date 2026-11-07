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

Install: `irm https://wecommander.app/install/center.ps1 | iex`
(`-Tauri` for the earlier tray app).
