param(
  [string]$ServiceName = "WebRisingCommender",
  [int]$Minutes = 45
)
$ErrorActionPreference = "Stop"
# Never print the agent JSON, device token, pairing token or passwords.
$lines = [System.Collections.Generic.List[string]]::new()
$svc = Get-CimInstance Win32_Service -Filter ("Name='{0}'" -f $ServiceName.Replace("'","''")) -ErrorAction SilentlyContinue
if (-not $svc) {
  $lines.Add("SERVICE_NOT_INSTALLED: $ServiceName")
  $lines -join [Environment]::NewLine
  return
}
$lines.Add("Service: $($svc.Name)")
$lines.Add("State: $($svc.State)")
$lines.Add("Startup: $($svc.StartMode)")
$lines.Add("Account: $($svc.StartName)")
$lines.Add("Exit code: $($svc.ExitCode)")
$lines.Add("Specific exit code: $($svc.ServiceSpecificExitCode)")
if ($svc.ExitCode -eq 1069) {
  $lines.Add("CAUSE: Service logon failed. Check the account password (not a Windows Hello PIN) and Log on as a service permission.")
} elseif ($svc.ServiceSpecificExitCode -eq 1) {
  $lines.Add("CAUSE: Agent config could not be loaded by the service account (missing file, invalid JSON, or inaccessible allowed root).")
} elseif ($svc.ServiceSpecificExitCode -eq 2) {
  $lines.Add("CAUSE: Agent runtime initialization failed.")
} elseif ($svc.ServiceSpecificExitCode -eq 3) {
  $lines.Add("CAUSE: Agent stopped after starting due to an internal runtime error.")
}
# PathName contains only a binary path and an agent configuration path. It
# must not contain command-line credentials in a supported installation.
# Only report whether the referenced executable/config exist; never print config.
$command = [string]$svc.PathName
$matches = [regex]::Matches($command, '"([^"]+)"')
if ($matches.Count -ge 1) {
  $binary = $matches[0].Groups[1].Value
  $lines.Add("Executable present: $(Test-Path -LiteralPath $binary -PathType Leaf)")
}
if ($matches.Count -ge 2) {
  $config = $matches[1].Groups[1].Value
  $lines.Add("Config present for this user: $(Test-Path -LiteralPath $config -PathType Leaf)")
}
$events = @()
try {
  $events = @(Get-WinEvent -FilterHashtable @{
    LogName = "System"
    ProviderName = "Service Control Manager"
    StartTime = (Get-Date).AddMinutes(-[Math]::Min([Math]::Max($Minutes,1),1440))
  } -ErrorAction Stop | Where-Object {
    $_.Message -like "*$ServiceName*" -or $_.Message -like "*WECOMMANDER Agent*"
  } | Select-Object -First 6)
} catch {
  $lines.Add("System service events unavailable: $($_.Exception.GetType().Name)")
}
foreach ($entry in $events) {
  $message = [string]$entry.Message
  # Keep diagnostics compact and avoid reporting full command lines.
  $message = ($message -replace '\s+', ' ').Trim()
  if ($message.Length -gt 300) { $message = $message.Substring(0,300) }
  $lines.Add("SCM event $($entry.Id) at $($entry.TimeCreated): $message")
}
if ($events.Count -eq 0) { $lines.Add("No recent matching Service Control Manager events.") }
if ($svc.State -ne "Running") {
  $lines.Add("Not running. A wrong service-account password, missing Log on as a service right, or unreadable agent config can cause startup failure.")
}
$lines -join [Environment]::NewLine
