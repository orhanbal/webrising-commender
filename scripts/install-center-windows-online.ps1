# WECOMMANDER app installer for Windows (PowerShell 5.1+).
# Usage: irm https://wecommander.app/install.ps1 | iex
#        (also /install/center.ps1, and the panel's WECOMMANDER-Kur.cmd)
# Installs for the current user only (no administrator rights): downloads the
# native WinUI 3 app (.zip, with the agent inside) from the newest GitHub
# preview release, verifies it against SHA256SUMS.txt, unpacks it to
# %LOCALAPPDATA%\Programs\WECOMMANDER Center, adds a Start menu shortcut and
# starts it. The app signs in through the browser, pairs this computer by
# itself, runs the agent in the background and starts with Windows. Files
# downloaded this way carry no "from the internet" mark, so Windows shows no
# SmartScreen warning for them.
# -Tauri installs the earlier cross-platform tray app (.exe) instead.
[CmdletBinding()]
param([switch]$DryRun,[switch]$Tauri)
$ErrorActionPreference='Stop'
# Brand banner: the WECOMMANDER icon with the name and what is being installed
# (fits 80 columns). Block characters are built at run time so this
# file stays ASCII (Windows PowerShell 5.1 reads files as ANSI).
function Show-WecommanderBanner([string]$Subtitle){
  $narrow=@(
    '       ,#######,',
    '     ,###########',
    '     #############       @TITLE@',
    '     #####^ ^#####',
    '     ^##^ ,#, ^##        @SUB@',
    '        ,#####',
    '      ,########,'
  )
  $lines = $narrow
  foreach($line in $lines){
    $text=$line.Replace('@TITLE@','W E C O M M A N D E R').Replace('@SUB@',$Subtitle)
    if($text -notmatch '[A-Za-z]'){ $text=$text.Replace('#',[string][char]0x2588).Replace('^',[string][char]0x2580).Replace(',',[string][char]0x2584) }
    else { $art=$text.Substring(0,[Math]::Min(22,$text.Length)); $rest=$text.Substring($art.Length); $text=$art.Replace('#',[string][char]0x2588).Replace('^',[string][char]0x2580).Replace(',',[string][char]0x2584)+$rest }
    Write-Host $text
  }
  Write-Host ""
}
$ProgressPreference='SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Show-WecommanderBanner 'Windows installer'
$repo='orhanbal/webrising-commender'
$releases='https://api.github.com/repos/'+$repo+'/releases?per_page=30'
$name=if($Tauri){'WECOMMANDER-Center-windows-x64.exe'}else{'WECOMMANDER-Center-windows-x64.zip'}
$temp=Join-Path ([IO.Path]::GetTempPath()) ('wecommander-center-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null
try {
  $headers=@{'Accept'='application/vnd.github+json';'User-Agent'='WECOMMANDER-Center-Installer'}
  if($env:GITHUB_TOKEN){$headers['Authorization']='Bearer '+$env:GITHUB_TOKEN}
  # Windows PowerShell 5.1 emits a JSON array as one object: store, then pipe.
  $raw=Invoke-RestMethod -Uri $releases -Headers $headers -TimeoutSec 30
  $releaseItems=@($raw | ForEach-Object { $_ })
  $results=@($releaseItems | Sort-Object -Descending -Property @{Expression={ if($_.tag_name -match '-([0-9]+)$'){[int64]$Matches[1]}else{[int64]0} }})
  $candidate=$null
  foreach($r in $results){
    if($r.draft -or -not $r.prerelease -or $r.tag_name -notmatch '^ubuntu-preview-[0-9]+$'){continue}
    $app=@($r.assets | Where-Object { $_.name -ceq $name } | Select-Object -First 1)
    $sums=@($r.assets | Where-Object { $_.name -ceq 'SHA256SUMS.txt' } | Select-Object -First 1)
    if($app.Count -eq 0 -or $sums.Count -eq 0){continue}
    $prefix="https://github.com/$repo/releases/download/$($r.tag_name)/"
    if(-not $app[0].browser_download_url.StartsWith($prefix) -or
       -not $sums[0].browser_download_url.StartsWith($prefix)){continue}
    $candidate=@{tag=$r.tag_name;app=$app[0].browser_download_url;sum=$sums[0].browser_download_url}
    break
  }
  if(-not $candidate){throw 'No preview release with the Management Center yet. Check the latest successful GitHub CI and Releases.'}
  if($DryRun){Write-Host "WECOMMANDER Center dry run: would install $($candidate.tag) from $($candidate.app)"; return}

  if($Tauri){
    # The Tauri window is a WebView2 page; Windows 10 (current) and 11 include it.
    $wv='{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    $hasWebView=@(
      "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$wv",
      "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$wv",
      "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$wv"
    ) | Where-Object { Test-Path $_ }
    if(-not $hasWebView){
      Write-Warning 'Microsoft Edge WebView2 Runtime was not found. Install it from https://developer.microsoft.com/microsoft-edge/webview2/ if the window stays blank.'
    }
  }

  $download=Join-Path $temp $name
  $checksumFile=Join-Path $temp 'SHA256SUMS.txt'
  Write-Host "WECOMMANDER $($candidate.tag): downloading..."
  Invoke-WebRequest -UseBasicParsing -Uri $candidate.app -OutFile $download -TimeoutSec 150
  Invoke-WebRequest -UseBasicParsing -Uri $candidate.sum -OutFile $checksumFile -TimeoutSec 30
  $matching=@(Get-Content $checksumFile | Where-Object {$_ -match ('^([a-fA-F0-9]{64})\s+\*?'+[regex]::Escape($name)+'$')})
  if($matching.Count -ne 1){throw 'The Management Center has no unique matching checksum. Aborting.'}
  $expected=([regex]::Match($matching[0],'^[a-fA-F0-9]{64}')).Value
  $actual=(Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash
  if($expected -ine $actual){throw 'Checksum mismatch. Aborting.'}
  Write-Host 'SHA256 verified.'

  $dir=Join-Path $env:LOCALAPPDATA 'Programs\WECOMMANDER Center'
  $exe=Join-Path $dir $(if($Tauri){'wecommander-center.exe'}else{'WecommanderCenter.exe'})
  # Replace a running copy of either version (upgrade or switch). A process
  # whose path cannot be read (another session, elevated shell) is matched by
  # name; the old files stay locked until every copy has exited, so wait for
  # that and retry the removal instead of failing on the first locked DLL.
  $running=@(Get-Process -Name 'WecommanderCenter','wecommander-center' -ErrorAction SilentlyContinue |
    Where-Object { -not $_.Path -or $_.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) })
  if($running.Count -gt 0){
    Write-Host 'Closing the running WECOMMANDER Center...'
    $refused=$false
    foreach($p in $running){
      try { Stop-Process -Id $p.Id -Force -ErrorAction Stop }
      catch { if(Get-Process -Id $p.Id -ErrorAction SilentlyContinue){ $refused=$true } }
    }
    $running | Wait-Process -Timeout 15 -ErrorAction SilentlyContinue
    if($refused -and @($running | Where-Object { Get-Process -Id $_.Id -ErrorAction SilentlyContinue }).Count -gt 0){
      # Typically a copy that an earlier install started from an administrator
      # PowerShell: a normal PowerShell may not end it.
      throw 'The running WECOMMANDER Center could not be closed (it may have been started as administrator). Quit it from the tray menu (Cikis), or run this command once in an administrator PowerShell, then try again.'
    }
  }
  for($attempt=1; (Test-Path -LiteralPath $dir); $attempt++){
    try { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop }
    catch {
      if($attempt -ge 10){ throw ('The old WECOMMANDER Center files are still in use. Quit it from the tray menu (Cikis) and run this command again. ' + $_.Exception.Message) }
      Start-Sleep -Seconds 1
    }
  }
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  if($Tauri){
    Copy-Item -LiteralPath $download -Destination $exe -Force
  } else {
    Expand-Archive -LiteralPath $download -DestinationPath $dir -Force
    if(-not (Test-Path -LiteralPath $exe -PathType Leaf)){ throw 'The package does not contain WecommanderCenter.exe. Aborting.' }
  }

  # One app now: the earlier "Yonetim Merkezi" shortcut is replaced.
  $programs=[Environment]::GetFolderPath('Programs')
  Remove-Item -LiteralPath (Join-Path $programs 'WECOMMANDER Yonetim Merkezi.lnk') -Force -ErrorAction SilentlyContinue
  $menu=Join-Path $programs 'WECOMMANDER.lnk'
  $shell=New-Object -ComObject WScript.Shell
  $shortcut=$shell.CreateShortcut($menu)
  $shortcut.TargetPath=$exe
  $shortcut.WorkingDirectory=$dir
  $shortcut.Description='WECOMMANDER: sunucular, terminaller, onaylar ve bu bilgisayarin ajani'
  $shortcut.Save()

  # Start it as the signed-in user even from an administrator PowerShell:
  # an elevated tray app cannot be closed or updated later without admin.
  $elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if($elevated){ Start-Process -FilePath "$env:WINDIR\explorer.exe" -ArgumentList ('"' + $exe + '"') }
  else { Start-Process -FilePath $exe -WorkingDirectory $dir }
  Write-Host 'WECOMMANDER installed and started. Sign in to your account in the browser window it opens;'
  Write-Host 'this computer is then connected by itself and the agent runs in the background.'
  Write-Host 'The WECOMMANDER icon is in the notification area (system tray).'
  Write-Host 'To remove it: quit it from the tray menu, then delete' $dir 'and the Start menu shortcut.'
} finally {
  Remove-Item -LiteralPath $temp -Force -Recurse -ErrorAction SilentlyContinue
}
