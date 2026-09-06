# Starts Caddy with this repo's Caddyfile.
#
# The binary is not committed (it is ~50 MB and platform-specific). Download
# caddy_windows_amd64.zip from https://github.com/caddyserver/caddy/releases,
# unzip, rename it to caddy.exe and drop it in infra/caddy/bin/.
#
# No administrator needed: Windows has no privileged-port restriction, so
# binding 443 works as a normal user. Caddy keeps its certificates under
# %AppData%\Caddy and renews them by itself.
#
# Keep this file ASCII-only and BOM'd. Windows PowerShell 5.1 reads a BOM-less
# .ps1 as Windows-1252, which has broken a script in this repo before.

$ErrorActionPreference = 'Stop'

$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe    = Join-Path $here 'bin\caddy.exe'
$config = Join-Path $here 'Caddyfile'

if (-not (Test-Path $exe)) {
    Write-Host "caddy.exe not found at $exe" -ForegroundColor Red
    Write-Host "Download it from https://github.com/caddyserver/caddy/releases"
    Write-Host "(caddy_<version>_windows_amd64.zip), unzip, rename to caddy.exe,"
    Write-Host "and put it there."
    exit 1
}

if (-not (Test-Path $config)) {
    Write-Host "Caddyfile not found at $config" -ForegroundColor Red
    exit 1
}

# Already listening? Starting a second one fails on the port bind with a less
# obvious message than this one.
if (Get-NetTCPConnection -LocalPort 443 -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "Something is already listening on 443 -- Caddy may be running." -ForegroundColor Yellow
    exit 1
}

# Caddy proxies to both of these. Neither has to be up for Caddy to start, but
# a certificate request that succeeds while the backend is down looks like a
# working deployment that answers every request with 502, so say so now.
foreach ($svc in @(
    @{ Port = 3000; Name = 'chat server' },
    @{ Port = 7880; Name = 'LiveKit' }
)) {
    if (-not (Get-NetTCPConnection -LocalPort $svc.Port -State Listen -ErrorAction SilentlyContinue)) {
        Write-Host "Note: nothing is listening on $($svc.Port) -- the $($svc.Name) is not running yet." -ForegroundColor Yellow
    }
}

Write-Host "Caddy starting on :443 (config: Caddyfile)" -ForegroundColor Cyan
Write-Host "First run fetches certificates from Let's Encrypt; give it a few seconds."
& $exe run --config $config --adapter caddyfile
