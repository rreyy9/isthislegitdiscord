# Publish a desktop client build to the server.
#
# The client is built here; the server runs somewhere else. This uploads the
# build to that server and publishes it, after which every connected client is
# told a new version exists and offers it to whoever is using it.
#
# Run it from the machine that built the client:
#
#   powershell -ExecutionPolicy Bypass -File infra\publish-desktop-update.ps1 `
#       -ServerUrl https://isthislegit.duckdns.org -Username kreso
#
# Build first. This does not build:
#
#   npm run dist --workspace @isthislegit/desktop
#
# The account has to be an ADMIN on the server. The password is prompted for
# and never written anywhere.

[CmdletBinding()]
param(
    # e.g. https://isthislegit.duckdns.org
    [Parameter(Mandatory = $true)]
    [string] $ServerUrl,

    [Parameter(Mandatory = $true)]
    [string] $Username,

    # Where electron-builder left the release. Defaults to this checkout.
    [string] $ReleaseDir,

    # Prompted for if not supplied. Passing it on the command line puts it in
    # your shell history, so prefer the prompt.
    [System.Security.SecureString] $Password,

    # Upload and stage, but stop before publishing. Nothing is served to any
    # client until a publish, so this is safe to run and look at.
    [switch] $StageOnly
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 still negotiates TLS 1.0 by default against some
# stacks, which a modern server refuses outright.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Say  { param([string] $m) Write-Host "  $m" }
function Warn { param([string] $m) Write-Host "  ! $m" -ForegroundColor Yellow }
function Die  { param([string] $m) Write-Host "  x $m" -ForegroundColor Red; exit 1 }

# ------------------------------------------------------------- the release

if (-not $ReleaseDir) {
    $ReleaseDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'apps\desktop\release'
}
if (-not (Test-Path $ReleaseDir)) {
    Die "No release folder at $ReleaseDir. Run: npm run dist --workspace @isthislegit/desktop"
}

$yamlPath = Join-Path $ReleaseDir 'latest.yml'
if (-not (Test-Path $yamlPath)) {
    Die "No latest.yml in $ReleaseDir. electron-builder only writes one when a publish provider is configured; apps/desktop/package.json has one."
}

# Read with an explicit encoding and split on newlines, then match per line.
# A pattern anchored with $ against a CRLF file matches nothing, because \r is
# not whitespace to a character class - a failure this repository has paid for
# before.
$yamlText = [IO.File]::ReadAllText($yamlPath, (New-Object Text.UTF8Encoding($false)))
$lines = $yamlText -split "`r?`n"

$version = $null
$named = New-Object System.Collections.Generic.HashSet[string]
foreach ($line in $lines) {
    if (-not $version -and $line -match '^version:\s*(.+?)\s*$') {
        $version = $Matches[1].Trim("'", '"')
    }
    if ($line -match '^\s*-?\s*url:\s*(.+?)\s*$') {
        $null = $named.Add([uri]::UnescapeDataString($Matches[1].Trim("'", '"')))
    }
}

if (-not $version) { Die "latest.yml has no version line." }
if ($named.Count -eq 0) { Die "latest.yml names no installer file." }

# latest.yml, the installer it names, and the blockmap beside it. The blockmap
# is what makes the next update a delta rather than another full download;
# without it updates still work, so it is wanted and not required.
$files = @('latest.yml')
foreach ($n in $named) {
    if (-not (Test-Path (Join-Path $ReleaseDir $n))) {
        Die "latest.yml names $n, which is not in $ReleaseDir."
    }
    $files += $n
    $blockmap = "$n.blockmap"
    if (Test-Path (Join-Path $ReleaseDir $blockmap)) {
        $files += $blockmap
    } else {
        Warn "no $blockmap - clients will download the whole installer"
    }
}

$totalBytes = 0
foreach ($f in $files) { $totalBytes += (Get-Item (Join-Path $ReleaseDir $f)).Length }

Write-Host ""
Say "Release:   $version"
Say "From:      $ReleaseDir"
Say "Files:     $($files -join ', ')"
Say ("Size:      {0:N1} MB" -f ($totalBytes / 1MB))

# --------------------------------------------------------------- the server

$ServerUrl = $ServerUrl.TrimEnd('/')
if ($ServerUrl -notmatch '^https://') {
    Warn "$ServerUrl is not https. The build is unsigned, so TLS is the only"
    Warn "thing proving an update came from your server - clients refuse to"
    Warn "auto-update over plain http, and will publish but never install this."
}
Say "Server:    $ServerUrl"
Write-Host ""

if (-not $Password) {
    $Password = Read-Host "  Password for $Username" -AsSecureString
}
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password))

try {
    $login = Invoke-RestMethod -Uri "$ServerUrl/api/login" -Method Post `
        -ContentType 'application/json' -TimeoutSec 30 `
        -Body (@{ username = $Username; password = $plain } | ConvertTo-Json)
} catch {
    Die "Could not sign in to $ServerUrl : $($_.Exception.Message)"
} finally {
    $plain = $null
}

if (-not $login.token) { Die "Sign-in returned no token." }
$auth = @{ Authorization = "Bearer $($login.token)" }
Say "Signed in as $Username."

# What is already published, so the version check fails here rather than after
# a ten-minute upload.
try {
    $current = Invoke-RestMethod -Uri "$ServerUrl/api/admin/updates" -Headers $auth -TimeoutSec 30
} catch {
    Die "That account cannot publish updates (is it an ADMIN?): $($_.Exception.Message)"
}
if ($current.release) {
    Say "Published now: $($current.release.version)"
    if ($current.release.version -eq $version) {
        Die "$version is already published. Bump the version in apps/desktop/package.json and rebuild."
    }
} else {
    Say "Published now: nothing"
}

# ------------------------------------------------------------- the upload

Write-Host ""
foreach ($f in $files) {
    $path = Join-Path $ReleaseDir $f
    $mb = (Get-Item $path).Length / 1MB
    Say ("Uploading {0} ({1:N1} MB)..." -f $f, $mb)
    try {
        # Raw body, streamed from disk. An hour's timeout because this is a
        # home connection's upstream and the installer is not small.
        $null = Invoke-RestMethod -Uri "$ServerUrl/api/admin/updates/staging/$f" `
            -Method Put -InFile $path -ContentType 'application/octet-stream' `
            -Headers $auth -TimeoutSec 3600
    } catch {
        # The server clears staging on a failed upload, so there is nothing
        # half-finished left behind to publish by accident.
        Die "Upload of $f failed: $($_.Exception.Message)"
    }
}

if ($StageOnly) {
    Write-Host ""
    Say "Staged $version on $ServerUrl. Nothing is served to clients yet."
    Say "Publish it from the console's Updates tab, or re-run without -StageOnly."
    exit 0
}

# ------------------------------------------------------------- the publish

Write-Host ""
try {
    $result = Invoke-RestMethod -Uri "$ServerUrl/api/admin/updates/publish" -Method Post `
        -ContentType 'application/json' -Body '{}' -Headers $auth -TimeoutSec 120
} catch {
    Die "Publish failed: $($_.Exception.Message)"
}

Write-Host ""
Say "Published $($result.release.version)."
Say "Told $($result.notified) connected client(s); everyone else finds out on next launch."
Write-Host ""
