param(
 [Parameter(Mandatory=$true)][string]$ConfigPath,
 [Parameter(Mandatory=$true)][string]$BinaryPath,
 [Parameter(Mandatory=$true)][string]$Account
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
try {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Windows Administrator privileges are required.'
  }
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'Agent configuration not found. Pair your device first.' }
  if (-not (Test-Path -LiteralPath $BinaryPath -PathType Leaf)) { throw 'Agent executable not found.' }
  $service = Get-Service -Name 'WebRisingCommender' -ErrorAction SilentlyContinue
  if ($service) {
    # Preserve existing device identity. Never silently overwrite enrollment.
    if ($service.Status -ne 'Running') {
      Start-Service -Name 'WebRisingCommender' -ErrorAction Stop
    }
  } else {
    $cred = Get-Credential -UserName $Account -Message 'Use your Windows account password, not the Windows Hello PIN.'
    if (-not $cred) { throw 'Windows service installation cancelled.' }
    & (Join-Path $PSScriptRoot 'install-windows.ps1') -BinaryPath $BinaryPath -ConfigPath $ConfigPath -Credential $cred
  }
  $running = Get-Service -Name 'WebRisingCommender' -ErrorAction Stop
  if ($running.Status -ne 'Running') { throw "Service was installed but is $($running.Status)." }
  [System.Windows.Forms.MessageBox]::Show('Windows service is running. Verify this device is online in WECOMMANDER.', 'WECOMMANDER') | Out-Null
} catch {
  $failure = $_.Exception.Message
  $report = ''
  $diagnostic = Join-Path $PSScriptRoot 'Diagnose-Service.ps1'
  if (Test-Path -LiteralPath $diagnostic) {
    try { $report = (& $diagnostic | Out-String) } catch { $report = 'Diagnostic collection failed.' }
  }
  $message = ("Windows service could not start.", $failure, "", $report) -join [Environment]::NewLine
  [System.Windows.Forms.MessageBox]::Show(
    $message, 'WECOMMANDER - Service error',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
  exit 1
}
