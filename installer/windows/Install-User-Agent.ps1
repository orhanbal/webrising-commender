param(
  [Parameter(Mandatory=$true)][string]$BinaryPath,
  [Parameter(Mandatory=$true)][string]$ConfigPath,
  [string]$TaskName,
  [switch]$SkipStart
)
$ErrorActionPreference = 'Stop'
Import-Module ScheduledTasks -ErrorAction Stop
function Resolve-TaskPrincipalSid {
  param([string]$UserId)
  if ([string]::IsNullOrWhiteSpace($UserId)) { return $null }
  if ($UserId -match '^S-\d-\d+(?:-\d+)+$') { return $UserId }
  $names = @($UserId)
  if (-not $UserId.Contains('\') -and -not $UserId.Contains('@')) {
    $names += "$env:COMPUTERNAME\$UserId"
  }
  foreach ($candidate in $names) {
    try {
      $account = [System.Security.Principal.NTAccount]::new([string]$candidate)
      return $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
      # Untranslatable identity is never accepted as the current user.
    }
  }
  return $null
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
$expectedTaskName = "WECOMMANDER-Agent-$sid"
if (-not $TaskName) { $TaskName = $expectedTaskName }
if ($TaskName -ne $expectedTaskName) {
  throw 'Task name must match the current signed-in Windows user SID.'
}
if (-not (Test-Path -LiteralPath $BinaryPath -PathType Leaf)) {
  throw 'Agent executable was not found.'
}
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
  throw 'Enrollment configuration was not found.'
}
$BinaryPath = (Resolve-Path -LiteralPath $BinaryPath).Path
$ConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
$launcher = Join-Path $PSScriptRoot 'Run-User-Agent.ps1'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
  throw 'Background launcher was not found.'
}

# Config validation must not print device credentials.
& $BinaryPath --config $ConfigPath doctor | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw 'Agent configuration validation failed.'
}
$legacy = Get-Service -Name 'WebRisingCommender' -ErrorAction SilentlyContinue
if ($legacy) {
  throw 'Old Windows service still exists. Migrate it first, preserving agent.json.'
}

$powershell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$launchArgs = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -BinaryPath "{1}" -ConfigPath "{2}"' -f $launcher,$BinaryPath,$ConfigPath
# Windows 11 hands console programs to Windows Terminal, which ignores
# -WindowStyle Hidden: the agent showed up as an open terminal window (and
# closing it stopped the agent). A headless console host never opens one.
$conhost = "$env:SystemRoot\System32\conhost.exe"
if (Test-Path -LiteralPath $conhost -PathType Leaf) {
  $action = New-ScheduledTaskAction -Execute $conhost -Argument ('--headless "{0}" {1}' -f $powershell,$launchArgs)
} else {
  $action = New-ScheduledTaskAction -Execute $powershell -Argument $launchArgs
}
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

# Older installers registered this task from the elevated setup, so the
# user's own session may not be allowed to stop, delete or overwrite it
# ("Access is denied"; it may not even be visible). Then remove it once with
# a UAC prompt; the pairing (agent.json) is kept and nothing else runs elevated.
function Remove-AgentTaskElevated {
  param([string]$Name)
  Get-Process -Name 'webrising-commender' -ErrorAction SilentlyContinue |
    Where-Object { $_.SessionId -eq (Get-Process -Id $PID).SessionId } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  $command = "Stop-ScheduledTask -TaskName '$Name' -ErrorAction SilentlyContinue; " +
             "Unregister-ScheduledTask -TaskName '$Name' -Confirm:`$false -ErrorAction SilentlyContinue; " +
             "if (Get-ScheduledTask -TaskName '$Name' -ErrorAction SilentlyContinue) { exit 1 }"
  try {
    $p = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Verb RunAs -WindowStyle Hidden -Wait -PassThru `
      -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',$command
  } catch {
    throw 'The old agent task needs administrator approval to be replaced, and it was not given.'
  }
  if ($p.ExitCode -ne 0) { throw 'The old agent task could not be removed, even with administrator approval.' }
}
function Test-AccessDenied($err) {
  $text = [string]$err.Exception.Message
  return ($err.Exception.HResult -eq -2147024891) -or ($text -match 'Access is denied|Erişim engellendi|0x80070005')
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  if ((Resolve-TaskPrincipalSid ([string]$existing.Principal.UserId)) -ne $sid) {
    throw 'Scheduled task belongs to another Windows user; refusing to overwrite it.'
  }
  try {
    if ($existing.State -eq 'Running') {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
  } catch {
    if (-not (Test-AccessDenied $_)) { throw }
    Remove-AgentTaskElevated $TaskName
  }
}
# Task Scheduler rejects some spellings of the same account with "The
# parameter is incorrect. (n,m):UserId:" (Microsoft and Azure AD accounts:
# the display name "AzureAD\Name" does not resolve). Try the SID first, then
# the names, and keep the first form this computer accepts.
$userForms = @($sid, $identity.Name, "$env:USERDOMAIN\$env:USERNAME") | Where-Object { $_ } | Select-Object -Unique
$registered = $false
$lastError = $null
$elevatedRemoval = $false
foreach ($principalUser in $userForms) {
  foreach ($triggerUser in $userForms) {
    try {
      $trigger = New-ScheduledTaskTrigger -AtLogOn -User $triggerUser
      $principal = New-ScheduledTaskPrincipal -UserId $principalUser -LogonType Interactive -RunLevel Limited
      Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'WECOMMANDER agent runs only while its Windows user is signed in; no password stored.' -ErrorAction Stop | Out-Null
      $registered = $true
      break
    } catch {
      $lastError = $_.Exception.Message
      # A task this session cannot see or overwrite (made by an elevated
      # installer): remove it once with approval, then retry this form.
      if ((Test-AccessDenied $_) -and -not $elevatedRemoval) {
        $elevatedRemoval = $true
        Remove-AgentTaskElevated $TaskName
        try {
          Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'WECOMMANDER agent runs only while its Windows user is signed in; no password stored.' -ErrorAction Stop | Out-Null
          $registered = $true
          break
        } catch {
          $lastError = $_.Exception.Message
        }
      }
    }
  }
  if ($registered) { break }
}
if (-not $registered) {
  throw "Scheduled task could not be registered: $lastError"
}

if ($SkipStart) {
  # GitHub Windows runners have no guaranteed interactive logon session.
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  if ($task.Principal.LogonType -ne 'Interactive' -or $task.Principal.RunLevel -ne 'Limited') {
    throw 'Scheduled task principal is not interactive and least privileged.'
  }
  Write-Output 'WECOMMANDER_TASK_REGISTERED_TEST_ONLY'
  return
}
try {
  Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  Start-Sleep -Seconds 3
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  if ($task.State -ne 'Running') {
    $lastResult = (Get-ScheduledTaskInfo -TaskName $TaskName).LastTaskResult
    throw "Agent did not stay running (state=$($task.State), result=$lastResult)."
  }
} catch {
  $reason = $_.Exception.Message
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
  throw "WECOMMANDER background startup failed: $reason"
}
Write-Output 'WECOMMANDER_TASK_RUNNING'
