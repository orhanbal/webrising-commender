# WECOMMANDER first-run enrollment. Run as the user who will own the service.
# Never echo pairing codes or device credentials into logs.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'webrising-commender.exe'
if (-not (Test-Path $exe)) { throw 'WECOMMANDER agent binary is missing.' }
$form = New-Object System.Windows.Forms.Form
$form.Text = 'WECOMMANDER | Cihaz Baglantisi'
$form.Width = 560; $form.Height = 440
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
$button.Text = 'Eslestir ve Hizmeti Kur'; $button.Location = New-Object System.Drawing.Point(285,337)
$button.Width = 235; $button.Height = 35
$form.Controls.Add($button)

# Device approval URLs contain only a random request ID, never the redemption secret.
# A link and copy button remain available if the browser fails to surface.
$script:approvalUrl = $null
$approvalLink = New-Object System.Windows.Forms.LinkLabel
$approvalLink.Text = 'Tarayicida cihaz onayini ac'
$approvalLink.LinkArea = [System.Windows.Forms.LinkArea]::new(0, $approvalLink.Text.Length)
$approvalLink.Location = New-Object System.Drawing.Point(20,278)
$approvalLink.Width = 500
$approvalLink.Height = 32
$approvalLink.Visible = $false
$form.Controls.Add($approvalLink)
$copyButton = New-Object System.Windows.Forms.Button
$copyButton.Text = 'Onay Baglantisini Kopyala'
$copyButton.Location = New-Object System.Drawing.Point(20,337)
$copyButton.Width = 248
$copyButton.Height = 35
$copyButton.Visible = $false
$form.Controls.Add($copyButton)

function Open-ApprovalPage {
  if (-not $script:approvalUrl) { return }
  try {
    $launch = New-Object System.Diagnostics.ProcessStartInfo
    $launch.FileName = $script:approvalUrl
    $launch.UseShellExecute = $true
    [void][System.Diagnostics.Process]::Start($launch)
    $notice.Text = 'Tarayicida cihazi onaylayin.'
    $form.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
  } catch {
    $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
    $notice.Text = 'Tarayici acilamadi. Onay baglantisini kopyalayin.'
  }
}
$approvalLink.Add_LinkClicked({ Open-ApprovalPage })
$copyButton.Add_Click({
  if ($script:approvalUrl) {
    [System.Windows.Forms.Clipboard]::SetText($script:approvalUrl)
    $notice.Text = 'Onay baglantisi panoya kopyalandi.'
  }
})

# A login session remains in the system browser, never in the agent process.
$script:linkRequest = $null
$script:linkSecret = $null
$script:linkDeadline = [DateTime]::MinValue
$script:pending = $false

function Install-EnrolledService([string]$config) {
  if (-not (Test-Path -LiteralPath $config -PathType Leaf)) {
    throw 'Agent configuration is missing. Do not pair again until the previous service has been examined.'
  }
  $account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $helper = Join-Path $PSScriptRoot 'Install-Service-Interactive.ps1'
  $params = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -ConfigPath "{1}" -BinaryPath "{2}" -Account "{3}"' -f $helper,$config,$exe,$account
  $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $params -Verb RunAs -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw 'Windows service could not start. See the diagnostic message in the administrator window.'
  }
  [System.Windows.Forms.MessageBox]::Show('Windows hizmeti calisiyor. Cihazin cevrimici oldugunu panelden kontrol edin.', 'WECOMMANDER') | Out-Null
  $form.Close()
}

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
  Install-EnrolledService $config
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
  if ($script:pending) { return }
  if ([DateTime]::UtcNow -gt $script:linkDeadline) {
    $timer.Stop()
    $notice.Text = 'Baglanti istegi sona erdi. Yeniden deneyin.'
    $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
    $script:approvalUrl = $null
    $approvalLink.Visible = $false
    $copyButton.Visible = $false
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
        $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
        $notice.Text = 'Onay alindi. Windows hizmeti kuruluyor...'
        try {
          Finish-Enrollment $reply.pairingCode
        } catch {
          $button.Enabled = $true
          $notice.Text = 'Onay alindi; hizmet kurulumu tamamlanamadi.'
          [System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'WECOMMANDER - Kurulum Hatasi') | Out-Null
        }
      }
      default {
        $timer.Stop(); $button.Enabled = $true
        $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
        $script:approvalUrl = $null
        $approvalLink.Visible = $false
        $copyButton.Visible = $false
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
    # If a service already exists, repair its startup without generating a
    # second cloud device or overwriting the original enrollment credentials.
    $service = Get-Service -Name 'WebRisingCommender' -ErrorAction SilentlyContinue
    if ($service) {
      $existingConfig = Join-Path $env:APPDATA 'webrising-commender\agent.json'
      if (-not (Test-Path -LiteralPath $existingConfig -PathType Leaf)) {
        throw 'Mevcut Windows hizmeti bulundu ama bu Windows hesabinin cihaz ayarlari bulunamadi. Yeniden eslestirmeden once hizmet hesabini kontrol edin.'
      }
      $notice.Text = 'Mevcut Windows hizmeti icin onarim deneniyor...'
      Install-EnrolledService $existingConfig
      return
    }
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
    $script:approvalUrl = "$url/connect-device?requestId=$($script:linkRequest)"
    $approvalLink.Visible = $true
    $copyButton.Visible = $true
    $timer.Start()
    Open-ApprovalPage
  } catch {
    $button.Enabled = $true
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'WECOMMANDER - Hata') | Out-Null
  }
})
$form.Add_FormClosing({ $timer.Stop() })
[void]$form.ShowDialog()
