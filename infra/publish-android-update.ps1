# Publish an Android build to the server.
#
# The APK is built here; the server runs somewhere else. This uploads the build
# to that server and publishes it, after which every connected phone is told a
# new version exists and offers it to whoever is using it.
#
# Run it from the machine that built the APK:
#
#   powershell -ExecutionPolicy Bypass -File infra\publish-android-update.ps1 `
#       -ServerUrl https://isthislegit.duckdns.org -Username kreso
#
# Build first. This does not build:
#
#   cd mobile
#   npm run apk
#
# The account has to be an ADMIN on the server. The password is prompted for
# and never written anywhere.
#
# The sibling of publish-desktop-update.ps1, deliberately shaped the same way
# so that publishing either client is the same sequence of steps. What differs
# is only the manifest: the desktop feed is electron-updater's latest.yml plus
# a blockmap, this one is a latest.json naming a single APK.

[CmdletBinding()]
param(
    # e.g. https://isthislegit.duckdns.org
    [Parameter(Mandatory = $true)]
    [string] $ServerUrl,

    [Parameter(Mandatory = $true)]
    [string] $Username,

    # Where build-apk.mjs left the release. Defaults to this checkout.
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
    $ReleaseDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'mobile\release'
}
if (-not (Test-Path $ReleaseDir)) {
    Die "No release folder at $ReleaseDir. Run: cd mobile; npm run apk"
}

$manifestPath = Join-Path $ReleaseDir 'latest.json'
if (-not (Test-Path $manifestPath)) {
    Die "No latest.json in $ReleaseDir. Run: cd mobile; npm run apk"
}

try {
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
} catch {
    Die "latest.json is not valid JSON: $($_.Exception.Message)"
}

$version     = $manifest.version
$versionCode = $manifest.versionCode
$apkName     = $manifest.apk

if (-not $version)     { Die "latest.json has no version." }
if (-not $versionCode) { Die "latest.json has no versionCode." }
if (-not $apkName)     { Die "latest.json names no APK." }

$apkPath = Join-Path $ReleaseDir $apkName
if (-not (Test-Path $apkPath)) {
    Die "latest.json names $apkName, which is not in $ReleaseDir."
}

# The server checks this too and refuses the publish if it disagrees. Checking
# here as well means a truncated or stale file is caught before an APK-sized
# upload over a home connection's upstream, rather than after it.
Say "Hashing $apkName..."
$actual = (Get-FileHash -Path $apkPath -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $manifest.sha256.ToLower()) {
    Die "$apkName does not match the sha256 in latest.json. Rebuild: npm run apk"
}

$files = @('latest.json', $apkName)
$totalBytes = 0
foreach ($f in $files) { $totalBytes += (Get-Item (Join-Path $ReleaseDir $f)).Length }

Write-Host ""
Say "Release:   $version (versionCode $versionCode)"
Say "From:      $ReleaseDir"
Say "Files:     $($files -join ', ')"
Say ("Size:      {0:N1} MB" -f ($totalBytes / 1MB))

# --------------------------------------------------------------- the server

$ServerUrl = $ServerUrl.TrimEnd('/')
if ($ServerUrl -notmatch '^https://') {
    Warn "$ServerUrl is not https. The APK is not signed by any store, so TLS"
    Warn "is the only thing proving this build came from your server. Phones"
    Warn "will download it over plain http without complaint, which is worse."
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

# What is already published, so both version checks fail here rather than after
# the upload. The versionCode one matters most: it is the number Android
# compares, and a build that does not move it reaches nobody.
try {
    $current = Invoke-RestMethod -Uri "$ServerUrl/api/admin/updates/android" `
        -Headers $auth -TimeoutSec 30
} catch {
    Die "That account cannot publish updates (is it an ADMIN?), or this server has no Android channel: $($_.Exception.Message)"
}

if ($current.release) {
    $published     = $current.release.manifest.version
    $publishedCode = $current.release.manifest.versionCode
    Say "Published now: $published (versionCode $publishedCode)"

    if ($versionCode -le $publishedCode) {
        Die @"
versionCode $versionCode is not above the published $publishedCode.
    Android refuses an install whose code has not risen, so this build would
    reach nobody. Bump the version in mobile/app.json and rebuild - the code
    is derived from it in app.config.js.
"@
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
        # home connection's upstream.
        $null = Invoke-RestMethod -Uri "$ServerUrl/api/admin/updates/android/staging/$f" `
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
    Say "Staged $version on $ServerUrl. Nothing is served to phones yet."
    Say "Re-run without -StageOnly to publish it."
    exit 0
}

# ------------------------------------------------------------- the publish

Write-Host ""
try {
    $result = Invoke-RestMethod -Uri "$ServerUrl/api/admin/updates/android/publish" `
        -Method Post -ContentType 'application/json' -Body '{}' `
        -Headers $auth -TimeoutSec 300
} catch {
    Die "Publish failed: $($_.Exception.Message)"
}

Write-Host ""
Say "Published $($result.release.manifest.version)."
Say "Told $($result.notified) connected client(s); everyone else finds out on next launch."
Say "The APK is at $ServerUrl/updates/android/$apkName"
Write-Host ""
