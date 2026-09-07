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
    # binary itself -- infra/livekit/start.ps1 says where from.
    [switch] $NoLiveKitBinary,

    # Leave caddy.exe out. The target box then has no TLS until the binary is
    # dropped into caddy\bin (see infra/caddy/start.ps1 for where from).
    [switch] $NoCaddyBinary,

    # Leave the isthislegit Server desktop app out. The install then has no
    # window or tray icon and is driven from start-all.ps1 and a browser
    # pointed at the console. Saves roughly 200 MB.
    [switch] $NoServerApp,

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

# The payload manifest.
#
# An update only has to touch the parts of the payload that actually changed,
# and it can only know which those are if the build says so. Roughly five of
# the six hundred megabytes below move in a typical release -- the compiled
# server, shared, the console -- while node_modules, the LiveKit binary and the
# 300 MB admin app sit still for months. Unpacking all of it over a running
# server, and restarting every service afterwards, is the difference between an
# update measured in seconds and one measured in minutes, with every voice call
# dropped for no reason.
#
# One SHA256 per component, over the file list and the file contents, in a
# stable order. Content and not timestamps: an npm install rewrites every mtime
# without changing a byte, and that would mark 193 MB as changed every build.
#
# Streamed into a single hash rather than Get-FileHash per file -- there are
# more than thirty thousand of them, and the per-call overhead is the whole
# cost at that count.
function Get-ComponentHash([string] $root, [string[]] $paths) {
    $files = New-Object System.Collections.Generic.List[IO.FileInfo]
    foreach ($p in $paths) {
        $full = Join-Path $root $p
        if (-not (Test-Path $full)) { continue }
        $item = Get-Item $full -Force
        if ($item.PSIsContainer) {
            foreach ($f in Get-ChildItem $full -Recurse -File -Force) { $files.Add($f) }
        } else {
            $files.Add($item)
        }
    }
    if ($files.Count -eq 0) { return $null }

    $prefix = $root.TrimEnd('\') + '\'
    # Lower-cased so the hash does not move with a casing change Windows itself
    # does not distinguish, and sorted so it does not move with directory order.
    $sorted = $files | Sort-Object { $_.FullName.Substring($prefix.Length).ToLowerInvariant() }

    $sha    = [Security.Cryptography.SHA256]::Create()
    $buffer = New-Object byte[] 1048576
    $bytes  = [long] 0
    try {
        foreach ($f in $sorted) {
            $rel  = $f.FullName.Substring($prefix.Length).ToLowerInvariant()
            $head = [Text.Encoding]::UTF8.GetBytes("$rel $($f.Length)`n")
            $null = $sha.TransformBlock($head, 0, $head.Length, $null, 0)

            $stream = [IO.File]::OpenRead($f.FullName)
            try {
                while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $null = $sha.TransformBlock($buffer, 0, $read, $null, 0)
                }
            } finally { $stream.Dispose() }
            $bytes += $f.Length
        }
        $null = $sha.TransformFinalBlock((New-Object byte[] 0), 0, 0)
        return [ordered] @{
            hash  = ([BitConverter]::ToString($sha.Hash) -replace '-', '').ToLowerInvariant()
            files = $sorted.Count
            bytes = $bytes
            # Recorded so install.ps1 does not need its own copy of the layout.
            # A second copy is a second thing to get wrong, and getting it wrong
            # here means an update that copies a folder nothing reads and leaves
            # the one that matters behind.
            paths = @($paths)
        }
    } finally { $sha.Dispose() }
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

# The admin app is packaged unpacked (electron-builder --dir) and staged as a
# folder rather than built into its own installer. One machine, one download:
# the server box should not have to run two setups to end up with a server and
# a way to administer it.
$serverAppUnpacked = Join-Path $repo 'apps\server-app\release\win-unpacked'
if ($NoServerApp) {
    Say "Skipping the admin app (-NoServerApp)." 'Yellow'
} elseif ($SkipBuild -and (Test-Path $serverAppUnpacked)) {
    Say "Reusing the existing admin app build (-SkipBuild)." 'Yellow'
} else {
    Say ""
    Say "Building the admin app (electron-builder --dir)"
    Invoke-Step 'npm run dist:dir' (Join-Path $repo 'apps\server-app') 'npm' @('run', 'dist:dir')
    if (-not (Test-Path $serverAppUnpacked)) {
        throw "electron-builder reported success but $serverAppUnpacked does not exist."
    }
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

# The admin app, as an unpacked Electron folder. install.ps1 puts a Start Menu
# and desktop shortcut on its executable, which is the thing anyone actually
# opens day to day.
if (-not $NoServerApp -and (Test-Path $serverAppUnpacked)) {
    Say "  app/"
    $appOut = Join-Path $staging 'app'
    New-Item -ItemType Directory -Path $appOut -Force | Out-Null
    # Contents, not the folder: copying win-unpacked itself would nest it as
    # app\win-unpacked and the shortcut below would point at nothing.
    Copy-Item (Join-Path $serverAppUnpacked '*') $appOut -Recurse -Force
}

# The firewall helper, the start/stop script and the installer itself. All three
# sit at the root of the payload, which is where start-all.ps1 detects it is in
# an installed copy rather than a repo checkout.
foreach ($file in @('infra\allow-lan.ps1', 'infra\start-all.ps1')) {
    Copy-Item (Join-Path $repo $file) $staging -Force -ErrorAction SilentlyContinue
}
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

# Exact versions, resolved from what is installed in this repo right now,
# rather than the caret ranges the manifest declares.
#
# A range means the target resolves whatever is newest at install time, so an
# installed server can be running dependencies no one here has ever run. That
# is not hypothetical: better-auth ^1.7.2 resolved to 1.7.3 on the target while
# the repo had 1.7.2, and 1.7.3 stopped sending a field the schema required, so
# every registration failed on a box where the identical code worked.
#
# Falls back to the declared range when a package is somehow not installed,
# which is worse but still builds.
function Resolve-InstalledVersion([string] $name, [string] $fallback) {
    foreach ($base in @(
        (Join-Path $repo "node_modules\$name\package.json"),
        (Join-Path $repo "apps\server\node_modules\$name\package.json")
    )) {
        if (Test-Path $base) {
            $v = (Get-Content $base -Raw | ConvertFrom-Json).version
            if ($v) { return $v }
        }
    }
    Say "    $name is not installed here -- shipping the range $fallback" 'Yellow'
    return $fallback
}

$deps = [ordered] @{}
foreach ($name in ($serverPkg.dependencies.PSObject.Properties.Name | Sort-Object)) {
    $deps[$name] = Resolve-InstalledVersion $name $serverPkg.dependencies.$name
}
$deps['@isthislegit/shared'] = 'file:../shared'
foreach ($tool in @('prisma', 'dotenv', 'typescript')) {
    $deps[$tool] = Resolve-InstalledVersion $tool $serverPkg.devDependencies.$tool
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
    Invoke-Step 'server: npm install --omit=dev' $serverOut 'npm' @('install', '--omit=dev', '--no-audit', '--no-fund')

    # The console needs its own copy of express. In the repo it resolves one
    # hoisted to the workspace root by npm, which is why this was never
    # noticed -- but an installed console sits beside the server rather than
    # inside a workspace, and the server's node_modules is not on its
    # resolution path. Without this it cannot start at all.
    Invoke-Step 'console: npm install --omit=dev' $consoleOut 'npm' @('install', '--omit=dev', '--no-audit', '--no-fund')
}

# ---------------------------------------------------------------- 4b. pruning

# npm has just installed a correct tree. It is also close to three times larger
# than the server needs, and every megabyte is paid for twice: once in the
# download, and again unpacking it onto a fresh box.
#
# Two sources, both measured against this tree rather than guessed at:
#
#   The staged manifest carries prisma the CLI, so install.ps1 can apply
#   migrations on the target. That one dependency also drags in Prisma Studio's
#   React front end and `prisma dev`'s embedded Postgres-compiled-to-WASM,
#   neither of which a server box will ever run. A runtime-only install of the
#   same twenty dependencies is 149 MB. With the CLI it is 405 MB.
#
#   @prisma/client inlines a base64 WASM query compiler per database engine.
#   The datasource is postgresql; the SQL Server, CockroachDB, MySQL and SQLite
#   compilers are 52 MB of engines this schema cannot target.
#
# Nothing here is a judgement call about what looks unused. A clean
# `npm install --omit=dev` of only the runtime dependencies installs none of
# these packages at all -- they arrive with the CLI and leave with it. Verified
# further by pruning a staged tree and re-running both halves: `prisma migrate
# status` still loaded the config, the schema and the migration engine and got
# as far as connecting, and the generated client still compiled and ran a query.
# If a future Prisma moves something into this set, migrations fail loudly
# during install rather than quietly at runtime, which is the failure mode to
# want.

if (-not $SkipDependencies) {
    Say ""
    Say "Pruning the staged tree"

    $before = Get-ChildItem $serverOut -Recurse -File | Measure-Object -Property Length -Sum

    # Whole packages nothing but `prisma studio` and `prisma dev` reach for.
    # typescript is on the list because prisma7.config.ts is TypeScript, which
    # reads as needing the compiler -- it does not. The config loader transpiles
    # it with jiti, and `prisma migrate status` behaves identically without it.
    $cliOnly = @(
        '@prisma\studio-core', '@prisma\dev', '@electric-sql',
        'react-dom', 'react', 'scheduler', 'elkjs', '@visx', 'remeda',
        'typescript'
    )
    foreach ($name in $cliOnly) {
        $path = Join-Path $serverOut "node_modules\$name"
        if (Test-Path $path) { Remove-Item $path -Recurse -Force }
    }

    # Query compilers for every engine except ours.
    $runtimeDir = Join-Path $serverOut 'node_modules\@prisma\client\runtime'
    if (Test-Path $runtimeDir) {
        Get-ChildItem $runtimeDir -File -Filter 'query_compiler*' |
            Where-Object { $_.Name -notlike '*postgresql*' } |
            Remove-Item -Force
    }

    # Source maps. Nothing on the target reads them, and there are three
    # thousand of them -- the unpack pays for that in file handles as much as
    # in bytes.
    Get-ChildItem (Join-Path $serverOut 'node_modules') -Recurse -File -Filter '*.map' |
        Remove-Item -Force

    $after   = Get-ChildItem $serverOut -Recurse -File | Measure-Object -Property Length -Sum
    $savedMb = [math]::Round(($before.Sum - $after.Sum) / 1MB, 1)
    Say "  removed $savedMb MB across $($before.Count - $after.Count) files"
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
    app         the isthislegit Server admin app (window + tray icon)
    app\         the isthislegit Server admin app (window and tray icon)
    install.ps1  everything the setup.exe does after unpacking

Day to day you want the isthislegit Server app. The installer puts it on the
desktop and in the Start Menu; it opens the operator console in a window.
Everything is configured from its Configuration tab -- hostnames, ports, voice
quality, and creating the database role -- and the first admin account is made
from its Accounts tab.

start-all.ps1 starts and stops the three services from a terminal, for when
that is easier than the app.

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

Updating an install that is already here
    Run the setup.exe again. It notices the existing install and updates it
    instead of asking the questions over: the payload is unpacked beside the
    running server, only the components whose contents actually changed are
    swapped in, and only the services that read them are restarted. In a
    typical release that is the chat server for a few seconds and nothing
    else -- calls in progress are not interrupted, because the LiveKit binary
    has not moved.

    If the server does not answer /api/health afterwards, the previous version
    is put back and the update reports the failure. A migration that has
    already run stays applied: Prisma has no down migrations, so migrations in
    this project have to be additive.

    installed.json records what is here and is what the next update compares
    against. Do not delete it -- without it an update has to replace all of it
    and restart everything, voice included.

    To do the same thing by hand from a zip, unpack it somewhere on the same
    volume as the install and run:

        powershell -ExecutionPolicy Bypass -File .\install.ps1 -Update -DryRun

    -DryRun prints exactly what would be replaced and restarted, and stops.
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

# --------------------------------------------------------- 5c. payload manifest

# Written last, so it describes the tree that is actually about to be compiled
# in, and read by install.ps1 on the target to work out what an update has to
# replace. See Get-ComponentHash above for why this exists at all.
#
# The component names are the contract between this script and install.ps1's
# $componentPolicy table, which maps each one to the service that has to be
# restarted when it moves. Adding a component here without adding it there
# means it is copied and nothing is restarted to pick it up.
Say ""
Say "Hashing the payload"

$components = [ordered] @{
    # The compiled server. Moves every release, and it is 1 MB.
    'server-dist'    = @('server\dist')

    # Schema and migration history. Its own component because a change here is
    # the one that means migrations have to run.
    'server-prisma'  = @('server\prisma', 'server\prisma7.config.ts')

    # 193 MB that moves only on a dependency bump.
    'server-deps'    = @('server\node_modules', 'server\package.json', 'server\package-lock.json')

    'shared'         = @('shared')
    'console'        = @('console')

    # The LiveKit binary, apart from its config: restarting LiveKit drops every
    # call in progress, so it is worth knowing that the 54 MB did not move and
    # the restart can be skipped.
    'livekit-bin'    = @('livekit\bin')

    # livekit.yaml is deliberately NOT here. install.ps1 rewrites it on the
    # target with that deployment's generated key pair and LAN address, so the
    # installed copy never matches the shipped template and never should --
    # hashing it would report a change on every update and then overwrite the
    # keys the server signs its voice tokens with.
    'livekit-config' = @('livekit\start.ps1')

    'caddy-bin'      = @('caddy\bin')

    # The Caddyfile does ship for real (it carries hostnames, not secrets), but
    # an operator may have edited the installed one. install.ps1 stages a
    # changed Caddyfile beside the live one rather than over it.
    'caddy-config'   = @('caddy\Caddyfile', 'caddy\start.ps1')

    # 319 MB of Electron that cannot be overwritten while the admin app is open.
    'app'            = @('app')

    'scripts'        = @('install.ps1', 'allow-lan.ps1', 'start-all.ps1', 'README.txt')
}

$manifest = [ordered] @{
    version    = $version
    builtAt    = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    components = [ordered] @{}
}

foreach ($name in $components.Keys) {
    $entry = Get-ComponentHash $staging $components[$name]
    if (-not $entry) {
        # A component left out on purpose (-NoServerApp, -NoCaddyBinary and so
        # on). Absent from the manifest means "this build says nothing about
        # it", which install.ps1 reads as leave the installed copy alone --
        # not as "delete it".
        Say "  $name  (not in this payload)" 'DarkGray'
        continue
    }
    $manifest.components[$name] = $entry
    Say ("  {0,-15} {1}  {2,6} files  {3,7:N1} MB" -f $name, $entry.hash.Substring(0, 12), $entry.files, ($entry.bytes / 1MB))
}

$manifest | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $staging 'payload.json') -Encoding UTF8

Say ""
Say "Compiling the installer"
Say "  solid LZMA over ~$((Get-ChildItem $staging -Recurse -File | Measure-Object).Count) files -- this is the slow part"

if (Test-Path $exePath) { Remove-Item $exePath -Force }

$nsi = Join-Path $here 'server-installer.nsi'
# Unpacked size, rounded up and with a little headroom. The installer refuses
# to start if the target volume has less than this free -- it unpacks beside the
# install rather than over it, so an update needs room for two copies at once,
# and running out halfway through one is the failure that would leave a stopped
# server and a half-written tree.
$payloadMb = [math]::Ceiling(((Get-ChildItem $staging -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB) * 1.1)

& $makensis '/V3' "/DPAYLOAD=$staging" "/DVERSION=$version" "/DVERSION4=$version4" "/DOUTFILE=$exePath" "/DPAYLOADMB=$payloadMb" $nsi
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
