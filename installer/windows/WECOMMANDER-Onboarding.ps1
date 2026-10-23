# WECOMMANDER first-run enrollment. Run as the user who will own the service.
# Never echo pairing codes or device credentials into logs.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'webrising-commender.exe'
if (-not (Test-Path $exe)) { throw 'WECOMMANDER agent binary is missing.' }
$form = New-Object System.Windows.Forms.Form
$form.Text = 'WECOMMANDER | Cihaz Baglantisi'
$form.Width = 560; $form.Height = 370
$form.StartPosition = 'CenterScreen'; $form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$fields = @(
  @('Sunucu adresi', 'https://wecommander.webrising.tr'),
  @('Tek kullanimlik eslestirme kodu', ''),
  @('Izin verilen klasor', [Environment]::GetFolderPath('UserProfile'))
)
$inputs = @()
for ($i=0; $i -lt $fields.Count; $i++) {
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $fields[$i][0]; $label.Location = New-Object System.Drawing.Point(20,(25 + $i * 65))
  $label.AutoSize = $true; $form.Controls.Add($label)
  $input = New-Object System.Windows.Forms.TextBox
  $input.Location = New-Object System.Drawing.Point(20,(47 + $i * 65))
  $input.Width = 500; $input.Text = $fields[$i][1]
  $form.Controls.Add($input); $inputs += $input
}
$notice = New-Object System.Windows.Forms.Label
$notice.Text = 'Once eslestirin. Ardindan Windows hizmetini kendi hesabiniza kurun.'
$notice.Location = New-Object System.Drawing.Point(20,232)
$notice.Width = 510; $notice.Height = 34
$form.Controls.Add($notice)
$button = New-Object System.Windows.Forms.Button
$button.Text = 'Eslestir ve Hizmeti Kur'; $button.Location = New-Object System.Drawing.Point(285,277)
$button.Width = 235; $button.Height = 35
$form.Controls.Add($button)
$button.Add_Click({
  $url=$inputs[0].Text.TrimEnd('/')
  $code=$inputs[1].Text.Trim()
  $root=$inputs[2].Text.Trim()
  if ($url -notmatch '^https://[^/]+$') {
    [System.Windows.Forms.MessageBox]::Show('Gecerli bir HTTPS sunucu adresi girin.'); return
  }
  if (-not $code -or -not (Test-Path -LiteralPath $root -PathType Container)) {
    [System.Windows.Forms.MessageBox]::Show('Gecerli bir eslestirme kodu ve klasor secin.'); return
  }
  $button.Enabled=$false
  try {
    # Config defaults to the interactive user's AppData. Service credential must
    # refer to this very same user to access the config and allowed roots.
    $arguments = @('enroll','--control-url',$url,'--pairing-code',$code,'--allowed-root',$root)
    $output = & $exe @arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw (($output | Out-String) -replace [regex]::Escape($code),'[REDACTED]') }
    $config = Join-Path $env:APPDATA 'webrising-commender\agent.json'
    if (-not (Test-Path $config)) { throw 'Agent configuration was not created.' }
    $account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $helper = Join-Path $PSScriptRoot 'Install-Service-Interactive.ps1'
    $params = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -ConfigPath "{1}" -BinaryPath "{2}" -Account "{3}"' -f $helper,$config,$exe,$account
    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $params -Verb RunAs -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw 'Windows hizmeti kurulumu iptal edildi veya basarisiz oldu.' }
    [System.Windows.Forms.MessageBox]::Show('WECOMMANDER Windows hizmeti kuruldu ve baslatildi.','WECOMMANDER') | Out-Null
    $form.Close()
  } catch {
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'WECOMMANDER - Hata') | Out-Null
  } finally { $button.Enabled=$true }
})
[void]$form.ShowDialog()
