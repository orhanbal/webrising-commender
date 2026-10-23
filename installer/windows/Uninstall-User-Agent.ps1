param([string]$TaskName)
$ErrorActionPreference = 'Stop'
Import-Module ScheduledTasks -ErrorAction Stop
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
