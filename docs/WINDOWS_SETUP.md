# WECOMMANDER Windows Setup — account-linked, password-free agent

Status: **Windows CI + real-device acceptance required**. Do not call the Windows release accepted until a physical Windows 10/11 client has confirmed start, reconnect and user tasks.

## Default installation

1. Run `WECOMMANDER-Setup-windows-x64.exe` from the latest successful CI package. The current Inno Setup package requires an **administrator UAC approval** because it must migrate the old Windows service. It does **not** request or store the Windows account password.
2. In the Windows **Cihaz Bağlantısı** window, select the allowed directory and click **Hesabımla Bağlan**.
3. Your system browser opens the WECOMMANDER device approval page. Sign in to your existing WECOMMANDER account, choose the workspace, and explicitly approve the device.
4. The desktop app redeems the one-time approval in the same user session, preserves the enrolled device configuration under `%APPDATA%\webrising-commender\agent.json`, and registers a least-privileged **Interactive** Task Scheduler task named `WECOMMANDER-Agent-<current-user-SID>`.
5. The scheduled task starts the Agent in a hidden PowerShell host as **the signed-in Windows user**, without a Windows account password. Task Scheduler starts it at future interactive logons. No administrator or LocalSystem rights are used for normal file/process operations.
6. Confirm your device appears online in the WECOMMANDER dashboard and that allowed-root policy is enforced. Sign out/sign in and verify the device reconnects.

**Limitation:** An `Interactive` task only runs while its specific user is signed in; it **cannot** start before Windows login. Offline/unattended-before-login operation is a separate, opt-in Windows service deployment using a restricted service identity. That is not the default experience.

## Upgrade from old password-based service

- Previous releases registered `WebRisingCommender` as a Windows service, prompting for the Windows account password. The new Setup contains `Migrate-Legacy-Service.ps1`, run with the elevated installer, to stop, disable and delete only that legacy service. Existing user enrollment/config credentials are **not removed**.
- After migration, the onboarding window detects existing `agent.json` and reuses the same device identity, registering the new user task without re-enrolling.
- If Windows cannot delete the legacy service (for example, it is marked for deletion while a process holds an SCM handle), close Services/PowerShell windows and retry the upgrade. The new user-task installer refuses to run alongside a registered legacy service. Do not clear the config or re-pair just to fix startup.
- If the installer was launched elevated as **another administrator account** instead of the user's own account, the onboarding task must be started separately from the regular user's session; the default user context is essential.

## Security and diagnostics

- Browser account password never enters the native Agent. Only the one-time request secret stays inside the Windows onboarding process; device credentials are stored in the user's AppData.
- `Install-User-Agent.ps1` sets `LogonType=Interactive` and `RunLevel=Limited`, so the Windows service-account credential prompt does not occur.
- The task belongs to the current user SID and uses only that user's permissions and configured allowed filesystem roots.
- The agent is launched with `-WindowStyle Hidden` under Task Scheduler, but this **is not** a system service. Do not equate it with pre-login 24/7 control.
- To diagnose from the same Windows account: `Get-ScheduledTask -TaskName "WECOMMANDER-Agent-$([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)" | Format-List TaskName,State`.
- To uninstall, use Windows Installed Apps; the task removal script preserves `agent.json` to avoid silently revoking credentials or losing data. Revoke the device from the dashboard when decommissioning it.
- The old `scripts/install-windows.ps1` remains only for advanced manual/CI service scenarios and should not be used in the consumer setup.

## Acceptance checks still required

- Inno Setup successfully compiles and includes every PowerShell installer and migration helper.
- Real Windows: GUI, account approval, migration from an existing stopped service, no Windows account-password prompt.
- Task is `Interactive` and `Limited`, remains running, reconnects after Windows sign-in and respects allowed roots.
- On a locked workstation / signed-out session, verify the documented limitation rather than claiming unattended access.
- Test standard non-administrator account, reboot, uninstallation and a failed-initial-start recovery.
