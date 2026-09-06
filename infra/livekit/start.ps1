# Starts the LiveKit server with this repo's config.
#
# The binary is not committed (it is ~40 MB and platform-specific). Download it
# once -- see README.md in this folder -- and drop livekit-server.exe in
# infra/livekit/bin/.

$ErrorActionPreference = 'Stop'

$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe    = Join-Path $here 'bin\livekit-server.exe'
$config = Join-Path $here 'livekit.yaml'

if (-not (Test-Path $exe)) {
    Write-Host "livekit-server.exe not found at $exe" -ForegroundColor Red
    Write-Host "Download it from https://github.com/livekit/livekit/releases"
    Write-Host "(livekit_<version>_windows_amd64.zip), unzip, and put the exe there."
    exit 1
}

# Already listening? Starting a second one just fails on the port bind, with a
# less obvious message than this.
if (Get-NetTCPConnection -LocalPort 7880 -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "Something is already listening on 7880 -- LiveKit may be running." -ForegroundColor Yellow
    exit 1
}

Write-Host "LiveKit starting on ws://localhost:7880 (config: livekit.yaml)" -ForegroundColor Cyan
& $exe --config $config
