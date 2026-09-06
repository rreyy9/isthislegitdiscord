# Builds the server-side installer: a single zip holding everything the server
# half of this project needs, plus install.ps1 to put it on a fresh Windows box.
#
# Why a zip + script and not NSIS/Inno like the desktop client: the desktop app
# is an Electron bundle electron-builder already knows how to wrap. The server
# half is a Node app, a Prisma migration set, a static console and a 55 MB
# LiveKit binary, and its install is mostly decisions (which IP, which Postgres,
# start on boot or not). That is a script's job. An installer toolchain would
# buy a progress bar and nothing else.
#
# Run it from anywhere:
#   powershell -ExecutionPolicy Bypass -File infra\installer\build-server-installer.ps1
#
# Keep this file ASCII-only and BOM'd. Windows PowerShell 5.1 reads a BOM-less
# .ps1 as Windows-1252, which has broken a script in this repo before.

[CmdletBinding()]
param(
    # Where the finished zip lands. Default: <repo>\release
    [string] $OutputDir,

    # Reuse whatever is already in apps/server/dist instead of rebuilding.
    [switch] $SkipBuild,

    # Skip the production npm install into the staging tree. The zip then has no
    # node_modules and install.ps1 cannot start the server, so this is for
    # iterating on the packaging itself, not for shipping.
    [switch] $SkipDependencies,

    # Leave livekit-server.exe out. The target box then has to download the
    # binary itself (see infra/livekit/README.md).
    [switch] $NoLiveKitBinary,

    # Leave caddy.exe out. The target box then has no TLS until the binary is
    # dropped into caddy\bin (see infra/caddy/start.ps1 for where from).
    [switch] $NoCaddyBinary,

    # Also emit a plain .zip of the same payload, for a box where running an
    # unsigned installer is not an option.
    [switch] $AlsoZip
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = (Resolve-Path (Join-Path $here '..\..')).Path

function Say([string] $text, [string] $color = 'Cyan') {
    Write-Host $text -ForegroundColor $color
}

function Invoke-Step([string] $label, [string] $workingDir, [string] $exe, [string[]] $exeArgs) {
    Say "  $label"
    Push-Location $workingDir
    try {
        & $exe @exeArgs
        if ($LASTEXITCODE -ne 0) {
            throw "$label failed (exit $LASTEXITCODE)"
        }
    } finally {
        Pop-Location
    }
}

# ------------------------------------------------------------------ 0. context

$serverPkgPath = Join-Path $repo 'apps\server\package.json'
$serverPkg     = Get-Content $serverPkgPath -Raw | ConvertFrom-Json
$version       = $serverPkg.version

if (-not $OutputDir) { $OutputDir = Join-Path $repo 'release' }
$staging = Join-Path $OutputDir "staging\isthislegit-server-$version"
$exePath = Join-Path $OutputDir "isthislegit-server-$version-setup.exe"
$zipPath = Join-Path $OutputDir "isthislegit-server-$version-setup.zip"

# VIProductVersion insists on four parts.
$version4 = $version
while (($version4.Split('.')).Count -lt 4) { $version4 = "$version4.0" }

# NSIS is not on PATH after a default install, so look where it actually lands.
$makensis = (Get-Command makensis -ErrorAction SilentlyContinue).Source
if (-not $makensis) {
    foreach ($candidate in @(
        "${env:ProgramFiles(x86)}\NSIS\makensis.exe",
        "$env:ProgramFiles\NSIS\makensis.exe"
    )) {
        if (Test-Path $candidate) { $makensis = $candidate; break }
    }
}
if (-not $makensis) {
    throw "makensis.exe not found. Install NSIS (winget install --id NSIS.NSIS) and run this again."
}

Say ""
Say "Building server installer $version"
Say "  repo     $repo"
Say "  makensis $makensis"
Say "  output   $exePath"
Say ""

# ------------------------------------------------------------------- 1. build

if ($SkipBuild) {
    Say "Skipping build (-SkipBuild)." 'Yellow'
    if (-not (Test-Path (Join-Path $repo 'apps\server\dist\main.js'))) {
        throw "apps/server/dist/main.js does not exist. Run without -SkipBuild."
    }
} else {
    Say "Building shared + server"
    # The root build script does shared then server, in that order. The server
    # imports zod schemas from shared at runtime, not only types, so shared has
    # to be compiled before the server is packaged.
    Invoke-Step 'npm run build' $repo 'npm' @('run', 'build')
}

$prismaClient = Join-Path $repo 'apps\server\dist\generated\prisma'
if (-not (Test-Path $prismaClient)) {
    throw "Generated Prisma client missing at $prismaClient. Run 'npm run db:generate' in apps/server, then build again."
}

# ------------------------------------------------------------------ 2. staging

Say ""
Say "Staging payload"

if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging -Force | Out-Null

$serverOut  = Join-Path $staging 'server'
$sharedOut  = Join-Path $staging 'shared'
$consoleOut = Join-Path $staging 'console'
$livekitOut = Join-Path $staging 'livekit'
$caddyOut   = Join-Path $staging 'caddy'
foreach ($d in @($serverOut, $sharedOut, $consoleOut, $livekitOut, $caddyOut)) {
    New-Item -ItemType Directory -Path $d -Force | Out-Null
}

# Server: the compiled output plus the Prisma schema and migration history.
# dist/generated/prisma travels inside dist, so the target never runs
# `prisma generate` -- it only applies migrations.
Say "  server/dist"
Copy-Item (Join-Path $repo 'apps\server\dist') $serverOut -Recurse -Force

Say "  server/prisma"
Copy-Item (Join-Path $repo 'apps\server\prisma') $serverOut -Recurse -Force

Say "  server/prisma7.config.ts"
Copy-Item (Join-Path $repo 'apps\server\prisma7.config.ts') $serverOut -Force
Copy-Item (Join-Path $repo 'apps\server\.env.example') $serverOut -Force -ErrorAction SilentlyContinue

# Shared, as a local file: dependency. It is a private workspace package, so it
# is on no registry and npm cannot fetch it by name on the target.
Say "  shared/"
Copy-Item (Join-Path $repo 'packages\shared\dist') $sharedOut -Recurse -Force
Copy-Item (Join-Path $repo 'packages\shared\package.json') $sharedOut -Force

# Console: no build step, one HTML file and a Node entry point.
Say "  console/"
Copy-Item (Join-Path $repo 'apps\console\*') $consoleOut -Recurse -Force -Exclude 'node_modules'

# LiveKit: config and start script always; the binary only if it is here and
# the caller wants it.
#
# The config staged here is livekit.example.yaml renamed, NOT this machine's
# livekit.yaml. That file holds the live API key pair, and anyone holding a
# pair can mint a join token for any voice room on the server that uses it --
# so shipping it inside an installer hands every recipient the keys to this
# deployment. install.ps1 generates a fresh pair on the target and rewrites the
# placeholders, so the template is all it ever needed.
Say "  livekit/"
$livekitTemplate = Join-Path $repo 'infra\livekit\livekit.example.yaml'
if (-not (Test-Path $livekitTemplate)) {
    throw "infra\livekit\livekit.example.yaml is missing. The installer must not fall back to livekit.yaml -- that file holds this deployment's real keys."
}
Copy-Item $livekitTemplate (Join-Path $livekitOut 'livekit.yaml') -Force
Copy-Item (Join-Path $repo 'infra\livekit\start.ps1') $livekitOut -Force
Copy-Item (Join-Path $repo 'infra\livekit\README.md') $livekitOut -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path (Join-Path $livekitOut 'bin') -Force | Out-Null

$livekitExe = Join-Path $repo 'infra\livekit\bin\livekit-server.exe'
if ($NoLiveKitBinary) {
    Say "    binary omitted (-NoLiveKitBinary)" 'Yellow'
} elseif (Test-Path $livekitExe) {
    Copy-Item $livekitExe (Join-Path $livekitOut 'bin') -Force
    Say "    livekit-server.exe included"
} else {
    Say "    livekit-server.exe not found in infra/livekit/bin -- omitted" 'Yellow'
}

# Caddy: the Caddyfile and its start script always; the binary only if it is
# here and the caller wants it.
#
# Unlike livekit.yaml, the Caddyfile carries no secret -- only two hostnames --
# so the real one ships rather than a template. That is deliberate: install.ps1
# reads the hostnames back out of it to decide whether this is an internet
# deployment, and a templated file would make every install LAN-only.
Say "  caddy/"
Copy-Item (Join-Path $repo 'infra\caddy\Caddyfile') $caddyOut -Force
Copy-Item (Join-Path $repo 'infra\caddy\start.ps1') $caddyOut -Force
New-Item -ItemType Directory -Path (Join-Path $caddyOut 'bin') -Force | Out-Null

$caddyExe = Join-Path $repo 'infra\caddy\bin\caddy.exe'
if ($NoCaddyBinary) {
    Say "    binary omitted (-NoCaddyBinary)" 'Yellow'
} elseif (Test-Path $caddyExe) {
    Copy-Item $caddyExe (Join-Path $caddyOut 'bin') -Force
    Say "    caddy.exe included"
} else {
    Say "    caddy.exe not found in infra/caddy/bin -- omitted, TLS will not start" 'Yellow'
}

# The tray icon and the console's app-window launcher. Both detect which layout
# they are in, so the same files work here and in an installed copy -- in an
# installed one the tray drives the scheduled tasks rather than spawning its own
# windows, because those tasks are what actually own the processes there.
Say "  tray/"
Copy-Item (Join-Path $repo 'infra\tray') $staging -Recurse -Force

# The firewall helper and the installer itself.
Copy-Item (Join-Path $repo 'infra\allow-lan.ps1') $staging -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $here 'install.ps1') $staging -Force

# ------------------------------------------- 3. a package.json the target uses

# The repo is an npm workspace, so apps/server has no node_modules of its own --
# everything is hoisted to the root and shared is a symlink. Neither survives a
# copy. So the staged server gets its own manifest: the same runtime
# dependencies, shared pointed at the copied folder, and the few tools
# install.ps1 needs on the target (prisma to apply migrations, dotenv and
# typescript because prisma7.config.ts is TypeScript and imports dotenv).
Say ""
Say "Writing staged manifest"

$deps = [ordered] @{}
foreach ($name in ($serverPkg.dependencies.PSObject.Properties.Name | Sort-Object)) {
    $deps[$name] = $serverPkg.dependencies.$name
}
$deps['@isthislegit/shared'] = 'file:../shared'
foreach ($tool in @('prisma', 'dotenv', 'typescript')) {
    $deps[$tool] = $serverPkg.devDependencies.$tool
}

$staged = [ordered] @{
    name         = 'isthislegit-server'
    version      = $version
    private      = $true
    main         = 'dist/main.js'
    scripts      = [ordered] @{
        start       = 'node dist/main.js'
        'db:deploy' = 'prisma migrate deploy'
        'db:seed'   = 'node dist/seed.js'
    }
    prisma       = [ordered] @{ seed = 'node dist/seed.js' }
    dependencies = $deps
}
$staged | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $serverOut 'package.json') -Encoding UTF8

# ------------------------------------------------------- 4. production install

if ($SkipDependencies) {
    Say "Skipping npm install (-SkipDependencies) -- the zip will not run as-is." 'Yellow'
} else {
    Say ""
    Say "Installing production dependencies into the staging tree"
    Say "  (this reaches the npm registry and takes a couple of minutes)"
    Invoke-Step 'npm install --omit=dev' $serverOut 'npm' @('install', '--omit=dev', '--no-audit', '--no-fund')
}

# ------------------------------------------------------------------- 5. readme

$readme = @"
isthislegit server $version
===========================

This folder is what the installer lays down. Normally you do not read it: run
isthislegit-server-$version-setup.exe and it does the lot.

    server\      the compiled chat server, Prisma schema and migrations
    shared\      schemas the server imports at runtime
    console\     the operator console (binds to 127.0.0.1 only, by design)
    livekit\     LiveKit config, start script and (usually) the binary
    caddy\       TLS reverse proxy: Caddyfile, start script and the binary
    tray\        tray icon, and the launcher that opens the console as an app
    install.ps1  everything the setup.exe does after unpacking

Day to day you want tray\isthislegit-console.vbs, which opens the operator
console in its own window. Everything is configured from its Configuration tab
-- hostnames, ports, voice quality, and creating the database role.

Requirements on the target box
    Windows 10/11 or Server, x64
    Node.js 22 or newer
    PostgreSQL 17 running as a service

install.ps1 is idempotent and can be re-run on its own, from an elevated
PowerShell:

    powershell -ExecutionPolicy Bypass -File .\install.ps1 -LanIp 192.168.1.230

Add -DryRun to see what it would do without touching anything, and -NoStartup
to skip the start-on-boot registration. Re-running keeps your database, your
.env and your LiveKit keys.
"@
$readme | Set-Content (Join-Path $staging 'README.txt') -Encoding ASCII

# ------------------------------------------------------------------- 6. makensis

# ------------------------------------------------------ 5b. secret leak check

# The build has one way to go badly wrong that nobody would notice: a file
# carrying this deployment's live secrets ends up in the payload, and the
# installer is then a copy of the keys handed to everyone who runs it. Both
# known leak paths are closed above (.env.example rather than .env,
# livekit.example.yaml rather than livekit.yaml) -- this fails the build if a
# third one ever opens.
Say ""
Say "Checking the payload for secrets"

$leaks = @()

# A generated LiveKit key is APIxxxxxxxxxxxx; the shipped template is
# APIchangeme, and LiveKit's own published pair is devkey/secret.
$leakPatterns = @(
    @{ Name = 'a real LiveKit API key'; Pattern = 'API[0-9a-f]{12}' },
    @{ Name = "LiveKit's published dev key"; Pattern = '(?m)^\s*devkey:' }
)

foreach ($file in Get-ChildItem $staging -Recurse -File -Include '*.yaml', '*.yml', '*.env', '*.example', '*.json', '*.ps1' |
        Where-Object { $_.FullName -notmatch '\\node_modules\\' }) {
    $text = Get-Content $file.FullName -Raw -ErrorAction SilentlyContinue
    if (-not $text) { continue }
    foreach ($p in $leakPatterns) {
        if ($text -match $p.Pattern) {
            $leaks += "$($file.FullName.Substring($staging.Length + 1)) contains $($p.Name)"
        }
    }
}

# .env itself must never be staged, whatever is in it.
foreach ($stray in Get-ChildItem $staging -Recurse -File -Filter '.env' -Force -ErrorAction SilentlyContinue) {
    $leaks += "$($stray.FullName.Substring($staging.Length + 1)) is a real .env -- only .env.example may ship"
}

if ($leaks.Count -gt 0) {
    $leaks | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    throw "Refusing to build: the staging tree carries live secrets. Fix the copy above, delete $staging, and run again."
}
Say "  clean -- no live key pair in the payload"

Say ""
Say "Compiling the installer"
Say "  solid LZMA over ~$((Get-ChildItem $staging -Recurse -File | Measure-Object).Count) files -- this is the slow part"

if (Test-Path $exePath) { Remove-Item $exePath -Force }

$nsi = Join-Path $here 'server-installer.nsi'
& $makensis '/V3' "/DPAYLOAD=$staging" "/DVERSION=$version" "/DVERSION4=$version4" "/DOUTFILE=$exePath" $nsi
if ($LASTEXITCODE -ne 0) { throw "makensis failed (exit $LASTEXITCODE)" }
if (-not (Test-Path $exePath)) { throw "makensis reported success but $exePath does not exist." }

$exeMb = [math]::Round((Get-Item $exePath).Length / 1MB, 1)

# ---------------------------------------------------------------- 7. optional zip

if ($AlsoZip) {
    Say ""
    Say "Also writing a zip"
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    Compress-Archive -Path $staging -DestinationPath $zipPath -CompressionLevel Optimal
    $zipMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
}

Say ""
Say "Done." 'Green'
Say "  $exePath  ($exeMb MB)" 'Green'
if ($AlsoZip) { Say "  $zipPath  ($zipMb MB)" 'Green' }
Say ""
Say "Staging tree left at $staging for inspection."
