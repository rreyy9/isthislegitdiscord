# Writes the LiveKit key pair from .env into livekit.yaml.
#
#   powershell -ExecutionPolicy Bypass -File infra\repair-livekit-keys.ps1
#   powershell -ExecutionPolicy Bypass -File infra\repair-livekit-keys.ps1 -InstallDir C:\isthislegit
#
# For a config that still has the template's APIchangeme placeholder, or whose
# key has drifted from the one the chat server signs tokens with. .env is the
# source of truth: the server signs with what is there, so LiveKit has to
# verify with the same pair.
#
# The two symptoms this fixes:
#   "api_key is required to use webhooks"  -- LiveKit refuses to start
#   voice connects and no audio arrives    -- mismatched pair, token rejected
#
# Safe to re-run. It only ever copies .env's values into the yaml.
#
# Keep this file ASCII-only and BOM'd. Windows PowerShell 5.1 reads a BOM-less
# .ps1 as Windows-1252, which has broken a script in this repo before.

[CmdletBinding()]
param(
    # An installed server. Omit to repair this repo checkout instead.
    [string] $InstallDir
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = (Resolve-Path (Join-Path $here '..')).Path

if ($InstallDir) {
    $envPath = Join-Path $InstallDir 'server\.env'
    $lkYaml  = Join-Path $InstallDir 'livekit\livekit.yaml'
} else {
    $envPath = Join-Path $repo 'apps\server\.env'
    $lkYaml  = Join-Path $repo 'infra\livekit\livekit.yaml'
}

foreach ($f in @($envPath, $lkYaml)) {
    if (-not (Test-Path $f)) {
        Write-Host "Not found: $f" -ForegroundColor Red
        if (-not $InstallDir) {
            Write-Host "For an installed server, pass -InstallDir C:\isthislegit"
        }
        exit 1
    }
}

function Get-EnvValue([string] $path, [string] $key) {
    foreach ($line in (Get-Content $path)) {
        if ($line -match "^\s*$key\s*=\s*(.*)$") { return $Matches[1].Trim().Trim('"') }
    }
    return $null
}

$key    = Get-EnvValue $envPath 'LIVEKIT_API_KEY'
$secret = Get-EnvValue $envPath 'LIVEKIT_API_SECRET'

if (-not $key -or -not $secret) {
    Write-Host "Could not read LIVEKIT_API_KEY / LIVEKIT_API_SECRET from $envPath" -ForegroundColor Red
    exit 1
}
if ($key -like 'APIchangeme*' -or $secret -like 'change-me*') {
    Write-Host ".env still holds the placeholder pair, so there is nothing real to copy." -ForegroundColor Red
    Write-Host "Generate one and put it in .env first:"
    Write-Host '  node -e "const c=require(''crypto'');console.log(''API''+c.randomBytes(6).toString(''hex''),c.randomBytes(32).toString(''base64url''))"'
    exit 1
}

# Line by line, never a multiline regex: this file is CRLF, and an anchored
# pattern that does not account for the \r fails by matching nothing at all --
# silently leaving the placeholder in place, which is the bug this exists to
# repair. `api_key` cannot collide with the key-entry pattern, because an
# underscore is not in [0-9a-zA-Z].
$keysWritten = 0
$hookWritten = 0

$lines = Get-Content $lkYaml | ForEach-Object {
    if ($_ -match '^(\s*)API[0-9a-zA-Z]+:\s*\S+\s*$') {
        $keysWritten++
        return "$($Matches[1])${key}: $secret"
    }
    if ($_ -match '^(\s*)api_key:') {
        $hookWritten++
        return "$($Matches[1])api_key: $key"
    }
    return $_
}

if ($keysWritten -eq 0 -and $hookWritten -eq 0) {
    Write-Host "Nothing to change -- no keys entry and no webhook api_key found in:" -ForegroundColor Yellow
    Write-Host "  $lkYaml"
    exit 1
}

# UTF-8 without a BOM: the comments contain non-ASCII punctuation, and Go's
# YAML parser should not be handed a BOM.
[IO.File]::WriteAllLines($lkYaml, $lines, (New-Object Text.UTF8Encoding($false)))

Write-Host ""
Write-Host "Patched $lkYaml" -ForegroundColor Green
Write-Host "  keys entry     $keysWritten line(s) -> $key"
Write-Host "  webhook api_key $hookWritten line(s) -> $key"
Write-Host "  secret taken from $envPath (not printed)"
Write-Host ""
Write-Host "Restart LiveKit for it to take effect."
