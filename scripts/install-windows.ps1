param(
  [Parameter(Mandatory=$true)][string]$BinaryPath,
  [Parameter(Mandatory=$true)][string]$ConfigPath,
  [string]$ServiceName = "WebRisingCommender",
  [System.Management.Automation.PSCredential]$Credential,
  [switch]$AllowLocalSystem
)

$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this installer from an elevated PowerShell session."
}

if ($Credential -and $AllowLocalSystem) {
  throw "Use either -Credential or -AllowLocalSystem, not both."
}
if (-not $Credential -and -not $AllowLocalSystem) {
  throw "Refusing to install as LocalSystem implicitly. Pass -Credential (recommended) or explicitly acknowledge the risk with -AllowLocalSystem."
}

$BinaryPath = (Resolve-Path $BinaryPath).Path
$ConfigPath = (Resolve-Path $ConfigPath).Path

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  throw "Service '$ServiceName' already exists. Uninstall it first."
}

$command = ('"{0}" --config "{1}" run' -f $BinaryPath, $ConfigPath)

$params = @{
  Name = $ServiceName
  BinaryPathName = $command
  DisplayName = "WebRising Commender Agent"
  Description = "Outbound WebRising Commender native agent"
  StartupType = "Automatic"
}
if ($Credential) {
  $params.Credential = $Credential
}

New-Service @params
sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
sc.exe failureflag $ServiceName 1 | Out-Null
Start-Service -Name $ServiceName

Write-Host "Installed and started $ServiceName"
Write-Host "Binary: $BinaryPath"
Write-Host "Config: $ConfigPath"
if ($Credential) {
  Write-Host "Service account: $($Credential.UserName)"
} else {
  Write-Warning "Service is running as LocalSystem because -AllowLocalSystem was explicitly supplied."
}
