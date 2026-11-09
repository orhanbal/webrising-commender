# WECOMMANDER first-run enrollment. Run in the signed-in Windows user's session.
# Never echo pairing codes or device credentials into logs.
# -Reconnect (Start menu "Cihaz Baglantisi") always shows the dialog; after an
# upgrade (Setup's post-install step) an existing pairing is reused silently.
param([switch]$Reconnect)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'webrising-commender.exe'
if (-not (Test-Path $exe)) { throw 'WECOMMANDER agent binary is missing.' }

# Upgrade: this Windows user is already paired, so restart the background
# agent with the new binary and keep the device identity; no dialog, no
# second "Hesabimla Baglan". Any failure falls through to the dialog.
# Started by the Management Center ("Ajani kur" / "Ajani guncelle"): the
# Center shows this output in its own window, so success needs no dialog.
$fromCenter = $env:WECOMMANDER_FROM_CENTER -eq '1'
function Show-Done([string]$message) {
  if ($fromCenter) { Write-Output $message }
  else { [System.Windows.Forms.MessageBox]::Show($message, 'WECOMMANDER') | Out-Null }
}
# Each step is written to %LOCALAPPDATA%\webrising-commender\onboarding.log
# (no secrets) so a fall-through can be diagnosed afterwards.
$logDir = Join-Path $env:LOCALAPPDATA 'webrising-commender'
$script:logFile = Join-Path $logDir 'onboarding.log'
function Write-OnboardingLog([string]$message) {
  try {
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    Add-Content -LiteralPath $script:logFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $message)
  } catch { }
}
$pairedConfig = Join-Path $env:APPDATA 'webrising-commender\agent.json'
$script:silentFailure = $null
$script:silentDone = $false
Write-OnboardingLog ("start reconnect=$Reconnect user=$([Security.Principal.WindowsIdentity]::GetCurrent().Name) config=$(Test-Path -LiteralPath $pairedConfig -PathType Leaf)")
if (-not $Reconnect -and (Test-Path -LiteralPath $pairedConfig -PathType Leaf)) {
  # Setup may still be closing the old agent: try twice before giving up.
  for ($attempt = 1; $attempt -le 2 -and -not $script:silentDone; $attempt++) {
    try {
      & (Join-Path $PSScriptRoot 'Install-User-Agent.ps1') -BinaryPath $exe -ConfigPath $pairedConfig | Out-Null
      $script:silentDone = $true
      Write-OnboardingLog "silent reuse ok (attempt $attempt)"
    } catch {
      $script:silentFailure = $_.Exception.Message
      Write-OnboardingLog "silent reuse failed (attempt $attempt): $($script:silentFailure)"
      Start-Sleep -Seconds 5
    }
  }
  if ($script:silentDone) {
    Show-Done 'WECOMMANDER ajani guncellendi ve arka planda calisiyor. Cihaz eslestirmesi korundu; yeniden baglanmaniz gerekmiyor.'
    return
  }
  # Fall through to the dialog; its notice shows why (see below).
}
# "Ajani kur" in a signed-in Management Center: the Center passes a one-time
# pairing code (5 minutes) in the environment, so the owner does not sign in
# a second time. Never logged or shown. Any failure falls through to the dialog.
$centerCode = $env:WECOMMANDER_PAIRING_CODE
$centerServer = $env:WECOMMANDER_SERVER
Remove-Item Env:WECOMMANDER_PAIRING_CODE -ErrorAction SilentlyContinue
if ($centerCode -and -not $script:silentDone -and -not (Test-Path -LiteralPath $pairedConfig -PathType Leaf)) {
  try {
    $url = if ($centerServer -match '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$') { $centerServer.TrimEnd('/') } else { 'https://wecommander.app' }
    $root = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'WECOMMANDER'
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { New-Item -ItemType Directory -Path $root -Force | Out-Null }
    $output = & $exe enroll --control-url $url --pairing-code $centerCode --allowed-root $root 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw (($output | Out-String) -replace [regex]::Escape($centerCode),'[REDACTED]').Trim()
    }
    if (-not (Test-Path -LiteralPath $pairedConfig -PathType Leaf)) { throw 'Agent config could not be created.' }
    & (Join-Path $PSScriptRoot 'Install-User-Agent.ps1') -BinaryPath $exe -ConfigPath $pairedConfig | Out-Null
    Write-OnboardingLog 'center pairing ok'
    Show-Done 'WECOMMANDER ajani kuruldu ve Yonetim Merkezi hesabinla baglandi. Arka planda calisiyor; Windows oturum acilisinda otomatik baslar.'
    return
  } catch {
    $script:silentFailure = $_.Exception.Message
    Write-OnboardingLog "center pairing failed: $($script:silentFailure)"
  }
}
$form = New-Object System.Windows.Forms.Form
$form.Text = 'WECOMMANDER | Cihaz Baglantisi'
$form.Width = 560; $form.Height = 440
$form.StartPosition = 'CenterScreen'; $form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$fields = @(
  @('Sunucu adresi', 'https://wecommander.app'),
  @('Manuel eslestirme kodu (istege bagli)', ''),
  @('Izin verilen klasor', (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'WECOMMANDER'))
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
$notice.Text = 'Hesabinla giris yap. Cihaz onayindan sonra otomatik baslatilir; Windows parolasi sorulmaz.'
if ($script:silentFailure) {
  $notice.Text = 'Otomatik baglanti tamamlanamadi: ' + $script:silentFailure + ' Asagidaki dugmeyle devam edebilirsin.'
}
$notice.Location = New-Object System.Drawing.Point(20,232)
$notice.Width = 510; $notice.Height = 44
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

function Install-EnrolledAgent([string]$config) {
  if (-not (Test-Path -LiteralPath $config -PathType Leaf)) {
    throw 'Agent configuration is missing. Pair this device before enabling startup.'
  }
  $scriptPath = Join-Path $PSScriptRoot 'Install-User-Agent.ps1'
  if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    throw 'The user-mode installer is missing. Download the latest WECOMMANDER Setup.'
  }
  & $scriptPath -BinaryPath $exe -ConfigPath $config
  $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
  [System.Windows.Forms.MessageBox]::Show(
    'WECOMMANDER arka planda calisiyor ve Windows oturum acilisinda otomatik baslayacak. Windows parolaniz gerekmiyor.',
    'WECOMMANDER'
  ) | Out-Null
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
  Install-EnrolledAgent $config
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
        $notice.Text = 'Onay alindi. Arka plan agent baslatiliyor...'
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
  if (-not $root -or -not [System.IO.Path]::IsPathRooted($root)) {
    [System.Windows.Forms.MessageBox]::Show('Izin verilen klasor tam bir yol olmali (or. C:\Users\ad\WECOMMANDER).'); return
  }
  $rootFull = [System.IO.Path]::GetFullPath($root).TrimEnd('\')
  $profileFull = [System.IO.Path]::GetFullPath([Environment]::GetFolderPath('UserProfile')).TrimEnd('\')
  if ($rootFull -eq $profileFull -or $rootFull -eq [System.IO.Path]::GetPathRoot($rootFull).TrimEnd('\')) {
    [System.Windows.Forms.MessageBox]::Show('Tum kullanici klasoru veya bir surucunun tamami izin verilen klasor olamaz. Ayri bir klasor secin, or. ' + (Join-Path $profileFull 'WECOMMANDER')); return
  }
  if (-not (Test-Path -LiteralPath $rootFull -PathType Container)) {
    try { New-Item -ItemType Directory -Path $rootFull -Force | Out-Null }
    catch { [System.Windows.Forms.MessageBox]::Show('Izin verilen klasor olusturulamadi: ' + $_.Exception.Message); return }
  }
  $root = $rootFull
  $inputs[2].Text = $rootFull
  $button.Enabled = $false
  try {
    # Reuse existing pairing after an upgrade or interrupted installation.
    # Never generate a second cloud device identity for the same local config.
    $existingConfig = Join-Path $env:APPDATA 'webrising-commender\agent.json'
    if (Test-Path -LiteralPath $existingConfig -PathType Leaf) {
      $existingUrl = $null
      try { $existingUrl = ([string](Get-Content -LiteralPath $existingConfig -Raw | ConvertFrom-Json).controlUrl).TrimEnd('/') } catch { }
      if ($existingUrl -and $existingUrl -eq $url) {
        $notice.Text = 'Mevcut cihaz eslestirmesi kullaniliyor. Arka plan agent baslatiliyor...'
        Install-EnrolledAgent $existingConfig
        return
      }
      # Pairing for another server (or unreadable): keep it as a backup and
      # pair again, never start an agent that cannot reach the chosen server.
      Get-ScheduledTask -TaskName 'WECOMMANDER-Agent-*' -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue
      $backup = $existingConfig + '.previous-' + (Get-Date -Format 'yyyyMMddHHmmss')
      Move-Item -LiteralPath $existingConfig -Destination $backup
      $notice.Text = 'Onceki eslestirme baska bir sunucuya aitti; yedeklendi. Yeni eslestirme baslatiliyor...'
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
