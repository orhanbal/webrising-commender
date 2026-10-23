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
  @('Manuel eslestirme kodu (istege bagli)', ''),
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
$notice.Text = 'Hesabinla baglan: tarayicida giris yap, cihaz baglantisini onayla.'
$notice.Location = New-Object System.Drawing.Point(20,232)
$notice.Width = 510; $notice.Height = 34
$form.Controls.Add($notice)
$button = New-Object System.Windows.Forms.Button
$button.Text = 'Eslestir ve Hizmeti Kur'; $button.Location = New-Object System.Drawing.Point(285,277)
$button.Width = 235; $button.Height = 35
$form.Controls.Add($button)

# A login session remains in the system browser, never in the agent process.
$script:linkRequest = $null
$script:linkSecret = $null
$script:linkDeadline = [DateTime]::MinValue
$script:pending = $false

function Finish-Enrollment([string]$pairingCode) {
  $url = $inputs[0].Text.TrimEnd('/')
  $root = $inputs[2].Text.Trim()
  $arguments = @('enroll','--control-url',$url,'--pairing-code',$pairingCode,'--allowed-root',$root)
  $output = & $exe @arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw (($output | Out-String) -replace [regex]::Escape($pairingCode),'[REDACTED]')
  }
  $config = Join-Path $env:APPDATA 'webrising-commender\agent.json'
  if (-not (Test-Path -LiteralPath $config)) { throw 'Agent config could not be created.' }
  $account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $helper = Join-Path $PSScriptRoot 'Install-Service-Interactive.ps1'
  $params = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -ConfigPath "{1}" -BinaryPath "{2}" -Account "{3}"' -f $helper,$config,$exe,$account
  $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $params -Verb RunAs -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw 'Windows service setup failed or was cancelled.' }
  [System.Windows.Forms.MessageBox]::Show('Cihaz baglandi ve Windows hizmeti baslatildi.','WECOMMANDER') | Out-Null
  $form.Close()
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
  if ($script:pending) { return }
  if ([DateTime]::UtcNow -gt $script:linkDeadline) {
    $timer.Stop()
    $notice.Text = 'Baglanti istegi sona erdi. Yeniden deneyin.'
    $button.Enabled = $true
    return
  }
  $script:pending = $true
  try {
    $baseUrl = $inputs[0].Text.TrimEnd('/')
    $data = @{ requestId=$script:linkRequest; requestSecret=$script:linkSecret } | ConvertTo-Json -Compress
    $reply = Invoke-RestMethod -Uri "$baseUrl/api/device-link/poll" -Method Post -Body $data -ContentType 'application/json' -TimeoutSec 8
    switch ($reply.status) {
      'pending' { $notice.Text = 'Tarayicida hesap onayi bekleniyor...' }
      'approved' {
        $timer.Stop()
        $notice.Text = 'Onay alindi. Windows hizmeti kuruluyor...'
        Finish-Enrollment $reply.pairingCode
      }
      default {
        $timer.Stop(); $button.Enabled = $true
        $notice.Text = 'Baglanti istegi gecersiz veya sona erdi.'
      }
    }
  } catch {
    # A momentary network failure must not discard the original request.
    $notice.Text = 'Sunucu ile baglanti bekleniyor...'
  } finally { $script:pending = $false }
})
$button.Text = 'Hesabimla Baglan'
$button.Add_Click({
  $url = $inputs[0].Text.TrimEnd('/')
  $root = $inputs[2].Text.Trim()
  if ($url -notmatch '^https://[^/]+$') {
    [System.Windows.Forms.MessageBox]::Show('Gecerli bir HTTPS sunucu adresi girin.'); return
  }
  if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    [System.Windows.Forms.MessageBox]::Show('Izin verilen klasor mevcut olmali.'); return
  }
  $button.Enabled = $false
  try {
    $manualCode = $inputs[1].Text.Trim()
    if ($manualCode) {
      Finish-Enrollment $manualCode
      return
    }
    $started = Invoke-RestMethod -Uri "$url/api/device-link/start" -Method Post -Body '{}' -ContentType 'application/json' -TimeoutSec 10
    $script:linkRequest = $started.requestId
    $script:linkSecret = $started.requestSecret
    $script:linkDeadline = [DateTime]::UtcNow.AddSeconds([double]$started.expiresInSeconds)
    $notice.Text = 'Tarayicida WECOMMANDER hesabinla giris yap ve onayla.'
    $approvalUrl = "$url/connect-device?requestId=$($script:linkRequest)"
    Start-Process $approvalUrl
    $timer.Start()
  } catch {
    $button.Enabled = $true
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'WECOMMANDER - Hata') | Out-Null
  }
})
$form.Add_FormClosing({ $timer.Stop() })
[void]$form.ShowDialog()
