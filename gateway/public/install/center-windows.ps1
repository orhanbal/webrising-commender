# WECOMMANDER Management Center (tray app) installer for Windows (PowerShell 5.1+).
# Usage: irm https://wecommander.app/install/center.ps1 | iex
# Installs for the current user only (no administrator rights): downloads the
# native WinUI 3 app (.zip) from the newest GitHub preview release, verifies it
# against SHA256SUMS.txt, unpacks it to %LOCALAPPDATA%\Programs\WECOMMANDER
# Center, adds a Start menu shortcut and starts it. The app then signs in
# through the browser and starts with Windows.
# -Tauri installs the earlier cross-platform tray app (.exe) instead.
[CmdletBinding()]
param([switch]$DryRun,[switch]$Tauri)
$ErrorActionPreference='Stop'
# Brand banner: the WECOMMANDER wordmark when the console is wide enough, else
# the icon with the name. Block characters are built at run time so this
# file stays ASCII (Windows PowerShell 5.1 reads files as ANSI).
function Show-WecommanderBanner([string]$Subtitle){
  $width=80
  try { $width=[int]$Host.UI.RawUI.WindowSize.Width } catch { }
  $wide=@(
    ',,,    ,,,    ,,',
    '^###   ###   ###                                                                  ,,',
    ' ###  ####,  ###  ,,,,      ,,,,   ,,,                                            ##',
    ' ###  #####  ##^ ,#####,   ##^##, #####, ,,,,, ,,,  ,,,,, ,,,   ,,,,  ,,,,,    ,,,##  ,,,   ,,,,',
    '  ##, ##### ### ,##^^^##  ##     ####### ##^####^#, ###^###^##  #^^#, ###^##  ##^### ,#^^#, ###^',
    '  ###### ##,### ###,,,##  #      ####### ##  ##  ## ##  ^#   #     ## ##   # ,#   ## ##  ## ##',
    '  ###### #####^ ########  #      ###^### ##  ##  ## ##   #   #  ##^## ##   # ##   ## ##^^^^ ##',
    '   ####  ^####  ###,  ,   #,     ## , ## ##  ##  ## ##   #   # ##  ## ##   #  #, ,## ##  ,  ##',
    '   ####   ####   ######,  ^#,,,#,^ ### ^ ##  ##  ## ##   #   #  ##### ##   #  ^#####  ####  ##',
    '   ^##^   ^##     ^###^    ^^##^  #####',
    '                                 ^^^^^^^'
  )
  $narrow=@(
    '       ,#######,',
    '     ,###########',
    '     #############       @TITLE@',
    '     #####^ ^#####',
    '     ^##^ ,#, ^##        @SUB@',
    '        ,#####',
    '      ,########,'
  )
  $lines = if($width -ge 100){ $wide + @('  ' + $Subtitle) } else { $narrow }
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
Show-WecommanderBanner 'Management Center installer'
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
  Write-Host "WECOMMANDER Center $($candidate.tag): downloading..."
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
    $running | Stop-Process -Force -ErrorAction SilentlyContinue
    $running | Wait-Process -Timeout 15 -ErrorAction SilentlyContinue
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

  $menu=Join-Path ([Environment]::GetFolderPath('Programs')) 'WECOMMANDER Yonetim Merkezi.lnk'
  $shell=New-Object -ComObject WScript.Shell
  $shortcut=$shell.CreateShortcut($menu)
  $shortcut.TargetPath=$exe
  $shortcut.WorkingDirectory=$dir
  $shortcut.Description='WECOMMANDER Yonetim Merkezi: onaylar ve otonom mod'
  $shortcut.Save()

  Start-Process -FilePath $exe -WorkingDirectory $dir
  Write-Host 'WECOMMANDER Management Center installed and started. Look for its icon in the notification area (system tray).'
  Write-Host 'To remove it: quit it from the tray menu, then delete' $dir 'and the Start menu shortcut.'
} finally {
  Remove-Item -LiteralPath $temp -Force -Recurse -ErrorAction SilentlyContinue
}
