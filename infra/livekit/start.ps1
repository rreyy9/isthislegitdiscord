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

# livekit.yaml holds a real API key pair, so it is gitignored and a fresh clone
# does not have one. Without this check LiveKit starts on its own defaults and
# rejects every join token, which reads as "voice is broken" rather than
# "there is no config".
if (-not (Test-Path $config)) {
    Write-Host "livekit.yaml not found at $config" -ForegroundColor Red
    Write-Host "Copy the template and fill in a key pair:"
    Write-Host "  copy infra\livekit\livekit.example.yaml infra\livekit\livekit.yaml"
    Write-Host "The pair must match LIVEKIT_API_KEY / LIVEKIT_API_SECRET in apps\server\.env."
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
