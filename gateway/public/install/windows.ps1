# WECOMMANDER direct Windows installer (PowerShell 5.1+).
# Verifies the downloaded Setup.exe against SHA256SUMS.txt before elevation.
[CmdletBinding()]
param([switch]$InstallOnly)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repo='orhanbal/webrising-commender'
$releases='https://api.github.com/repos/'+$repo+'/releases?per_page=30'
$temp=Join-Path ([IO.Path]::GetTempPath()) ('wecommander-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null
try {
  $headers=@{'Accept'='application/vnd.github+json';'User-Agent'='WECOMMANDER-Windows-Installer'}
  $results=@(Invoke-RestMethod -Uri $releases -Headers $headers -TimeoutSec 30)
  $name='WECOMMANDER-Setup-windows-x64.exe'
  $candidate=$null
  foreach($r in $results){
    if($r.draft -or -not $r.prerelease -or $r.tag_name -notmatch '^ubuntu-preview-[0-9]+$'){continue}
    $setup=@($r.assets | Where-Object { $_.name -ceq $name } | Select-Object -First 1)
    $sums=@($r.assets | Where-Object { $_.name -ceq 'SHA256SUMS.txt' } | Select-Object -First 1)
    if($setup.Count -eq 0 -or $sums.Count -eq 0){continue}
    $prefix="https://github.com/$repo/releases/download/$($r.tag_name)/"
    if(-not $setup[0].browser_download_url.StartsWith($prefix) -or
       -not $sums[0].browser_download_url.StartsWith($prefix)){continue}
    $candidate=@{tag=$r.tag_name;setup=$setup[0].browser_download_url;sum=$sums[0].browser_download_url}
    break
  }
  if(-not $candidate){throw 'No complete Windows Setup preview release found. Check the latest successful GitHub CI and Releases.'}
  $exe=Join-Path $temp $name
  $checksumFile=Join-Path $temp 'SHA256SUMS.txt'
  Write-Host "WECOMMANDER $($candidate.tag): Downloading checked installer..."
  Invoke-WebRequest -UseBasicParsing -Uri $candidate.setup -OutFile $exe -TimeoutSec 150
  Invoke-WebRequest -UseBasicParsing -Uri $candidate.sum -OutFile $checksumFile -TimeoutSec 30
  $matching=@(Get-Content $checksumFile | Where-Object {$_ -match ('^([a-fA-F0-9]{64})\s+\*?'+[regex]::Escape($name)+'$')})
  if($matching.Count -ne 1){throw 'Setup.exe has no unique matching checksum. Aborting.'}
  $expected=([regex]::Match($matching[0],'^[a-fA-F0-9]{64}')).Value
  $actual=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
  if($expected -ine $actual){throw 'Setup checksum mismatch. Aborting.'}
  Write-Host 'SHA256 verified. Requesting Windows UAC for the setup installer (not your Windows account password).'
  # /SILENT avoids a duplicate post-install enrollment launch.
  $args=@('/SILENT','/NORESTART')
  $p=Start-Process -FilePath $exe -ArgumentList $args -Verb RunAs -Wait -PassThru
  if($p.ExitCode -ne 0){throw "Setup failed: exit code $($p.ExitCode)"}
  Write-Host 'WECOMMANDER installed.'
  if(-not $InstallOnly){
    $onboarding=Join-Path $env:ProgramFiles 'WECOMMANDER\WECOMMANDER-Onboarding.ps1'
    if(-not (Test-Path -LiteralPath $onboarding -PathType Leaf)){
      throw 'Setup finished but the device onboarding helper is missing.'
    }
    Write-Host 'Opening account-based device enrollment.'
    & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File $onboarding
    if($LASTEXITCODE -ne 0){throw "Enrollment exited with code $LASTEXITCODE"}
  }
} finally {
  Remove-Item -LiteralPath $temp -Force -Recurse -ErrorAction SilentlyContinue
}
