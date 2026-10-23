# One-time migration from the password-based legacy Windows service.
# Runs elevated by Inno Setup, never touches the existing device enrollment.
$ErrorActionPreference='Stop'
$serviceName='WebRisingCommender'
$service=Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -ErrorAction SilentlyContinue
if(-not $service){exit 0}
if([string]$service.PathName -notmatch '(?i)webrising-commender\.exe') {
  throw 'An unfamiliar service uses the WECOMMANDER service name. Migration refused.'
}
if($service.State -ne 'Stopped') {
  Stop-Service -Name $serviceName -Force -ErrorAction Stop
}
& sc.exe config $serviceName start= disabled | Out-Null
if($LASTEXITCODE -ne 0){throw 'Could not disable the legacy service.'}
& sc.exe delete $serviceName | Out-Null
if($LASTEXITCODE -ne 0){throw 'Could not remove the legacy service.'}
# The enrollment lives in the invoking user's AppData and is NOT deleted.
