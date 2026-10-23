param(
  [Parameter(Mandatory=$true)][string]$BinaryPath,
  [Parameter(Mandatory=$true)][string]$ConfigPath
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $BinaryPath -PathType Leaf)) { exit 2 }
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { exit 3 }
# Keep the scheduled task alive for the lifetime of the agent. Task Scheduler
# owns restart behavior; credentials never appear in task command arguments.
& $BinaryPath --config $ConfigPath run
exit $LASTEXITCODE
