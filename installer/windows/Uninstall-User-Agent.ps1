param([string]$TaskName)
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
$ownTaskName = "WECOMMANDER-Agent-$sid"
if (-not $TaskName) { $TaskName = $ownTaskName }
if ($TaskName -ne $ownTaskName) {
  throw 'Refusing to remove a task outside the current user SID scope.'
}
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Output 'WECOMMANDER_TASK_NOT_INSTALLED'
  return
}
if ((Resolve-TaskPrincipalSid ([string]$task.Principal.UserId)) -ne $sid) {
  throw 'Refusing to remove a scheduled task belonging to another user.'
}
if ($task.State -eq 'Running') {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
}
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
# The enrolled device configuration remains until it is explicitly revoked.
Write-Output 'WECOMMANDER_TASK_REMOVED'
