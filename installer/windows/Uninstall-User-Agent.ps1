param([string]$TaskName)
$ErrorActionPreference = 'Stop'
Import-Module ScheduledTasks -ErrorAction Stop
function Resolve-TaskPrincipalSid([string]$UserId) {
  if ([string]::IsNullOrWhiteSpace($UserId)) { return $null }
  if ($UserId -match '^S-\d-\d+(-\d+)+$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$ownTaskName = "WECOMMANDER-Agent-$($identity.User.Value)"
if (-not $TaskName) { $TaskName = $ownTaskName }
if ($TaskName -ne $ownTaskName) { throw 'Refusing to remove a task outside the current user SID scope.' }
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) { Write-Output 'WECOMMANDER_TASK_NOT_INSTALLED'; return }
if ((Resolve-TaskPrincipalSid ([string]$task.Principal.UserId)) -ne $identity.User.Value) {
  throw 'Refusing to remove a scheduled task belonging to another user.'
}
if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop }
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
# User credential/config intentionally remains until explicitly revoked.
Write-Output 'WECOMMANDER_TASK_REMOVED'
) { return $UserId }
  # Task Scheduler normalizes an input SID to a domain\username or an
  # unqualified local account depending on Windows version and provider.
  $aliases = @($UserId)
  if (-not $UserId.Contains('\') -and -not $UserId.Contains('@')) {
    $aliases += "$env:COMPUTERNAME\$UserId"
  }
  foreach ($alias in $aliases) {
    try {
      return ([System.Security.Principal.NTAccount]::new($alias)).Translate(
        [System.Security.Principal.SecurityIdentifier]
      ).Value
    } catch {
      # Try another account form. Never treat failed translation as approval.
    }
  }
  return $null
}
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $TaskName) { $TaskName = "WECOMMANDER-Agent-$($identity.User.Value)" }
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) { Write-Output 'WECOMMANDER_TASK_NOT_INSTALLED'; return }
if ($task.Principal.UserId -notin @($identity.User.Value, $identity.Name)) {
  throw 'Refusing to remove a scheduled task belonging to another user.'
}
if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop }
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
# User credential/config intentionally remains until explicitly revoked.
Write-Output 'WECOMMANDER_TASK_REMOVED'
