param(
  [Parameter(Mandatory=$true)][string]$BinaryPath,
  [Parameter(Mandatory=$true)][string]$ConfigPath,
  [string]$TaskName
)
$ErrorActionPreference = 'Stop'
Import-Module ScheduledTasks -ErrorAction Stop
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
if (-not $TaskName) { $TaskName = "WECOMMANDER-Agent-$sid" }
if (-not (Test-Path -LiteralPath $BinaryPath -PathType Leaf)) { throw 'Agent executable was not found.' }
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'Enrollment configuration was not found.' }
$BinaryPath = (Resolve-Path -LiteralPath $BinaryPath).Path
$ConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
$launcher = Join-Path $PSScriptRoot 'Run-User-Agent.ps1'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Background launcher was not found.' }
# Validate before registering. Never print config contents, tokens or pairing codes.
& $BinaryPath --config $ConfigPath doctor | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Agent configuration validation failed.' }

$legacy = Get-Service -Name 'WebRisingCommender' -ErrorAction SilentlyContinue
if ($legacy) {
  throw 'An old WECOMMANDER Windows service is installed. Remove the old service through the previous administrator uninstaller before activating the user task. The device enrollment file is preserved.'
}

$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -BinaryPath "{1}" -ConfigPath "{2}"' -f $launcher, $BinaryPath, $ConfigPath)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
# Only manage the task owned by this SID. Never alter another user's task.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  if ($existing.Principal.UserId -notin @($sid, $identity.Name)) {
    throw 'Scheduled task belongs to another Windows user; refusing to overwrite it.'
  }
  if ($existing.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'WECOMMANDER agent – runs only while this Windows user is signed in; no password stored.' -ErrorAction Stop | Out-Null
try {
  Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  Start-Sleep -Seconds 3
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  if ($task.State -ne 'Running') {
    $last = (Get-ScheduledTaskInfo -TaskName $TaskName).LastTaskResult
    throw "Background agent did not remain running (task state=$($task.State), result=$last)."
  }
} catch {
  $reason = $_.Exception.Message
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
  throw "WECOMMANDER background startup failed: $reason"
}
Write-Output "WECOMMANDER_TASK_RUNNING"
