param(
 [Parameter(Mandatory=$true)][string]$ConfigPath,
 [Parameter(Mandatory=$true)][string]$BinaryPath,
 [Parameter(Mandatory=$true)][string]$Account
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Windows Administrator privileges are required.'
  }
  if (-not (Test-Path -LiteralPath $ConfigPath)) { throw 'Enrollment config not found.' }
  if (-not (Test-Path -LiteralPath $BinaryPath)) { throw 'Agent executable not found.' }
  $cred = Get-Credential -UserName $Account -Message 'Windows service account (same account used during enrollment)'
  if (-not $cred) { throw 'Windows service installation cancelled.' }
  & (Join-Path $PSScriptRoot 'install-windows.ps1') -BinaryPath $BinaryPath -ConfigPath $ConfigPath -Credential $cred
  [System.Windows.Forms.MessageBox]::Show('Windows service installed.','WECOMMANDER') | Out-Null
} catch {
  [System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'WECOMMANDER - Error') | Out-Null
  exit 1
}
