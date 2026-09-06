# Installs the isthislegit server on a Windows box.
#
# This script ships inside the zip built by build-server-installer.ps1 and
# expects to sit next to the server\, shared\, console\ and livekit\ folders
# from that zip. Running it straight out of the repo will not work -- build the
# installer first.
#
# It is idempotent. Run it again to upgrade: the database, the .env and the
# LiveKit key pair are all left alone once they exist.
#
# Keep this file ASCII-only and BOM'd. Windows PowerShell 5.1 reads a BOM-less
# .ps1 as Windows-1252, which has broken a script in this repo before.

[CmdletBinding()]
param(
    # Where the server ends up. Existing installs are upgraded in place.
    [string] $InstallDir = 'C:\isthislegit',

    # The address other machines reach this box on. LiveKit has to advertise it
    # explicitly: a box with several NICs picking the wrong one is silent
    # breakage -- everyone joins the call and no audio ever arrives.
    [string] $LanIp,

    # The chat server's HTTP port.
    [int] $Port = 3000,

    # Skip the psql role/database step (already done, or Postgres lives
    # elsewhere and DATABASE_URL will be edited by hand).
    [switch] $SkipPostgres,

    # Do not register the start-on-boot tasks.
    [switch] $NoStartup,

    # Add the LocalSubnet firewall rules as well.
    [switch] $AllowLan,

    # The postgres superuser password, used only to apply setup-postgres.sql.
    # Passed through PGPASSWORD so psql never prompts. Blank means "skip the
    # database role setup" when running non-interactively.
    [string] $PostgresPassword,

    # Never call Read-Host. The NSIS installer collects the same answers on its
    # own pages and passes them in, and it runs this script with no console to
    # prompt on -- a Read-Host there would hang the install with no visible
    # reason.
    [switch] $NonInteractive,

    # Print every step without changing anything.
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

$here      = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Join-Path $InstallDir 'server'
$lkDir     = Join-Path $InstallDir 'livekit'
$envPath   = Join-Path $serverDir '.env'

function Say([string] $text, [string] $color = 'Cyan') { Write-Host $text -ForegroundColor $color }
function Warn([string] $text) { Write-Host $text -ForegroundColor Yellow }
function Step([string] $text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }

function Would([string] $text) {
    if ($DryRun) { Write-Host "  would $text" -ForegroundColor DarkGray; return $true }
    Write-Host "  $text"
    return $false
}

function Test-Elevated {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# A long random string, safe to paste into a .env value. Base64 of 32 bytes is
# 44 characters, comfortably over LiveKit's 32-character minimum.
function New-Secret {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    [Convert]::ToBase64String($bytes) -replace '[+/=]', 'x'
}

function New-LiveKitKey {
    $bytes = New-Object byte[] 6
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    'API' + (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Get-EnvValue([string] $path, [string] $key) {
    if (-not (Test-Path $path)) { return $null }
    foreach ($line in (Get-Content $path)) {
        if ($line -match "^\s*$key\s*=\s*(.*)$") {
            return $Matches[1].Trim().Trim('"')
        }
    }
    return $null
}

Say ""
Say "isthislegit server installer"
Say "  payload      $here"
Say "  install dir  $InstallDir"
if ($DryRun) { Warn "  DRY RUN -- nothing will be changed" }

# ------------------------------------------------------------ 0. sanity checks

Step "Checking the payload"

foreach ($required in @('server\dist\main.js', 'server\package.json', 'shared\package.json', 'livekit\livekit.yaml')) {
    if (-not (Test-Path (Join-Path $here $required))) {
        throw "Missing $required next to this script. Run build-server-installer.ps1 and install from the zip it produces."
    }
}
if (-not (Test-Path (Join-Path $here 'server\node_modules'))) {
    Warn "  server\node_modules is missing -- the zip was built with -SkipDependencies."
    Warn "  The server will not start until dependencies are installed."
}
Say "  payload looks complete"

Step "Checking prerequisites"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw "Node.js is not on PATH. Install Node 22 or newer and run this again." }
$nodeVersion = (& node -v).Trim()
$nodeMajor = [int]($nodeVersion -replace '^v(\d+).*$', '$1')
if ($nodeMajor -lt 22) { throw "Node $nodeVersion is too old. This server needs Node 22 or newer." }
Say "  node $nodeVersion"

$elevated = Test-Elevated
if ($elevated) { Say "  running elevated" } else { Warn "  not elevated -- Postgres setup and boot registration will be skipped" }

if (-not $LanIp) {
    # Suggest the interface that has a default gateway, not simply the first
    # IPv4. A dev box carries VirtualBox, Hyper-V and link-local addresses as
    # well, and on this project's own machine the first IPv4 is VirtualBox's
    # 192.168.56.1 -- the wrong answer, and one whose failure mode is a call
    # that connects and carries no audio.
    $guess = (Get-NetIPConfiguration -ErrorAction SilentlyContinue |
        Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
        Select-Object -First 1).IPv4Address.IPAddress
    if ($DryRun -or $NonInteractive) {
        $LanIp = if ($guess) { $guess } else { '127.0.0.1' }
        Warn "  no -LanIp given; assuming $LanIp"
    } else {
        $prompt = if ($guess) { "LAN address for this box [$guess]" } else { 'LAN address for this box' }
        $answer = Read-Host $prompt
        $LanIp = if ($answer) { $answer.Trim() } else { $guess }
    }
}
if (-not $LanIp) { throw "No LAN address. Pass -LanIp." }
Say "  advertising $LanIp"

# ----------------------------------------------------------------- 1. payload

Step "Copying the payload to $InstallDir"

# Preserve anything the previous install owns: the .env holds generated secrets
# and the uploads folder holds real user data.
$envBackup = $null
if (Test-Path $envPath) {
    $envBackup = Get-Content $envPath -Raw
    Say "  existing .env found -- it will be kept"
}

# The NSIS installer has already unpacked the payload straight into the install
# directory before it calls this script, so there is nothing to copy and the
# copy would be a folder onto itself.
$inPlace = ($here.TrimEnd('\')) -ieq ($InstallDir.TrimEnd('\'))

if ($inPlace) {
    Say "  payload is already in place -- nothing to copy"
} elseif (-not (Would "copy server, shared, console and livekit")) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    foreach ($folder in @('server', 'shared', 'console', 'livekit')) {
        Copy-Item (Join-Path $here $folder) $InstallDir -Recurse -Force
    }
    foreach ($file in @('allow-lan.ps1', 'README.txt')) {
        $src = Join-Path $here $file
        if (Test-Path $src) { Copy-Item $src $InstallDir -Force }
    }
    if ($envBackup) { Set-Content $envPath $envBackup -Encoding ASCII -NoNewline }
}

# --------------------------------------------------------------- 2. PostgreSQL

Step "PostgreSQL"

if ($SkipPostgres) {
    Warn "  skipped (-SkipPostgres)"
} elseif (-not $elevated -and -not $DryRun) {
    Warn "  skipped -- needs an elevated terminal. Re-run elevated, or apply"
    Warn "  server\prisma\setup-postgres.sql by hand as the postgres superuser."
} else {
    $psql = (Get-Command psql -ErrorAction SilentlyContinue).Source
    if (-not $psql) {
        $candidate = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1
        if ($candidate) { $psql = $candidate.FullName }
    }

    if (-not $psql) {
        Warn "  psql.exe not found. Install PostgreSQL 17, then run:"
        Warn "    psql -U postgres -f `"$serverDir\prisma\setup-postgres.sql`""
    } elseif ($NonInteractive -and -not $PostgresPassword) {
        Warn "  skipped -- no postgres password was given and psql cannot prompt here."
        Warn "  Apply it by hand once, as the postgres superuser:"
        Warn "    psql -U postgres -f `"$serverDir\prisma\setup-postgres.sql`""
    } else {
        Say "  using $psql"
        # setup-postgres.sql is written to be safe to re-run: the role is created
        # inside an IF NOT EXISTS block and the database behind a \gexec guard.
        if (-not (Would "run setup-postgres.sql")) {
            $previousPgPassword = $env:PGPASSWORD
            try {
                $psqlArgs = @('-U', 'postgres', '-f', (Join-Path $serverDir 'prisma\setup-postgres.sql'))
                if ($PostgresPassword) {
                    # -w so a wrong password fails immediately. Without it psql
                    # falls back to a prompt, and under the GUI installer there
                    # is no console to prompt on -- it would just hang.
                    $env:PGPASSWORD = $PostgresPassword
                    $psqlArgs += '-w'
                }
                & $psql @psqlArgs
                if ($LASTEXITCODE -ne 0) { throw "setup-postgres.sql failed (exit $LASTEXITCODE). Wrong postgres password, or the service is not running." }
            } finally {
                $env:PGPASSWORD = $previousPgPassword
            }
        }
    }
}

# ---------------------------------------------------------- 3. .env and secrets

Step "Configuration"

if (Test-Path $envPath) {
    Say "  keeping the existing .env -- secrets and DATABASE_URL untouched"
    $lkKey    = Get-EnvValue $envPath 'LIVEKIT_API_KEY'
    $lkSecret = Get-EnvValue $envPath 'LIVEKIT_API_SECRET'
} else {
    $lkKey    = New-LiveKitKey
    $lkSecret = New-Secret
    $authSecret = New-Secret

    $envText = @"
# Written by install.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm'). Secrets below
# were generated for this machine. Keep this file off any shared drive.
DATABASE_URL="postgres://chat_app:chat_app_local_dev_pw@localhost:5432/chat?schema=public"

BETTER_AUTH_SECRET="$authSecret"
BETTER_AUTH_URL="http://${LanIp}:$Port"

PORT=$Port

LIVEKIT_URL="ws://${LanIp}:7880"
LIVEKIT_API_KEY="$lkKey"
LIVEKIT_API_SECRET="$lkSecret"

MAX_UPLOAD_BYTES=26214400

# Stated explicitly. The default is relative to the server's working directory
# and assumes the repo layout (cwd/../../data/uploads), which from an installed
# server\ folder resolves outside the install directory entirely. Forward
# slashes on purpose: dotenv treats backslashes in a double-quoted value as
# escape sequences.
UPLOAD_DIR="$($InstallDir -replace '\\', '/')/data/uploads"

VOICE_QUALITY="studio"
"@

    if (-not (Would "write $envPath with a fresh BETTER_AUTH_SECRET and LiveKit key pair")) {
        Set-Content $envPath $envText -Encoding ASCII
    }
    Say "  generated a new BETTER_AUTH_SECRET (not the .env.example placeholder)"
}

# LiveKit has to agree with the server about the key pair -- the server signs
# join tokens with it and LiveKit verifies them -- and about which address to
# advertise. Patch the shipped config rather than asking anyone to edit YAML.
$lkYaml = Join-Path $lkDir 'livekit.yaml'
if ($lkKey -and $lkSecret) {
    if (-not (Would "point livekit.yaml at $LanIp and the server's key pair")) {
        $yaml = Get-Content $lkYaml -Raw
        $yaml = $yaml -replace '(?m)^(\s*)node_ip:.*$', "`${1}node_ip: $LanIp"
        $yaml = $yaml -replace '(?m)^(\s*)API[0-9a-zA-Z]+:\s*\S+\s*$', "`${1}${lkKey}: $lkSecret"
        $yaml = $yaml -replace '(?m)^(\s*)api_key:.*$', "`${1}api_key: $lkKey"
        $yaml = $yaml -replace '(?m)^(\s*)-\s*http://[^\s]*?/api/livekit/webhook\s*$', "`${1}- http://127.0.0.1:$Port/api/livekit/webhook"
        # UTF-8 without a BOM. The comments in livekit.yaml contain non-ASCII
        # punctuation, so writing ASCII would mangle them, and Go's YAML parser
        # should not be handed a BOM.
        [IO.File]::WriteAllText($lkYaml, $yaml, (New-Object Text.UTF8Encoding($false)))
    }
} else {
    Warn "  could not read the LiveKit key pair from .env -- livekit.yaml left as shipped"
}

# ------------------------------------------------------------- 4. the database

Step "Applying migrations"

if (-not (Would "npx prisma migrate deploy")) {
    Push-Location $serverDir
    try {
        & npx --no-install prisma migrate deploy
        if ($LASTEXITCODE -ne 0) { throw "prisma migrate deploy failed (exit $LASTEXITCODE)" }
    } finally { Pop-Location }
}

Step "Seeding"

# The seed is idempotent and prints an invite code. The first account to
# register with it becomes the admin of that guild.
if (-not (Would "node dist/seed.js")) {
    # Tee it to a file. The seed prints the invite code, and under the GUI
    # installer the details window is gone the moment anyone clicks Finish.
    $seedLog = Join-Path $InstallDir 'invite-code.txt'
    Push-Location $serverDir
    try {
        & node dist\seed.js 2>&1 | Tee-Object -FilePath $seedLog
        if ($LASTEXITCODE -ne 0) { throw "seed failed (exit $LASTEXITCODE)" }
    } finally { Pop-Location }
    Say "  saved to $seedLog"
}

# --------------------------------------------------------------- 5. on boot

Step "Start on boot"

# Scheduled tasks rather than real services: Node has no built-in service host,
# and wrapping it would mean shipping nssm or winsw. A task at startup running
# as SYSTEM, with restart-on-failure, survives a reboot and a crash, which is
# the actual requirement -- ten people relying on this cannot need a human after
# every power cut.
if ($NoStartup) {
    Warn "  skipped (-NoStartup). Start by hand:"
    Warn "    node `"$serverDir\dist\main.js`""
    Warn "    powershell -File `"$lkDir\start.ps1`""
} elseif (-not $elevated -and -not $DryRun) {
    Warn "  skipped -- registering a startup task needs an elevated terminal."
} else {
    $lkExe = Join-Path $lkDir 'bin\livekit-server.exe'

    # On a dry run nothing has been copied yet, so look for the binary in the
    # payload instead of at its eventual home.
    $lkExeCheck = if ($DryRun) { Join-Path $here 'livekit\bin\livekit-server.exe' } else { $lkExe }

    $tasks = @(
        @{ Name = 'isthislegit-server';  Exe = $nodeCmd.Source; Args = 'dist\main.js';                       Dir = $serverDir; Check = $nodeCmd.Source },
        @{ Name = 'isthislegit-livekit'; Exe = $lkExe;          Args = "--config `"$lkDir\livekit.yaml`""; Dir = $lkDir;     Check = $lkExeCheck }
    )

    foreach ($t in $tasks) {
        if (-not (Test-Path $t.Check)) {
            Warn "  $($t.Name): $($t.Check) not found -- task not registered"
            continue
        }
        if (Would "register scheduled task $($t.Name)") { continue }

        # Unregister first: Register-ScheduledTask refuses to overwrite, and a
        # re-run of the installer must not fail on its own previous work.
        Unregister-ScheduledTask -TaskName $t.Name -Confirm:$false -ErrorAction SilentlyContinue

        $action    = New-ScheduledTaskAction -Execute $t.Exe -Argument $t.Args -WorkingDirectory $t.Dir
        $trigger   = New-ScheduledTaskTrigger -AtStartup
        $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

        Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $trigger `
            -Principal $principal -Settings $settings | Out-Null
        Say "  registered $($t.Name)"
    }
}

# ------------------------------------------------------------------ 6. firewall

if ($AllowLan) {
    Step "Firewall"
    $script = Join-Path $InstallDir 'allow-lan.ps1'
    if (-not (Test-Path $script)) {
        Warn "  allow-lan.ps1 was not in the payload"
    } elseif (-not $elevated -and -not $DryRun) {
        Warn "  skipped -- needs an elevated terminal"
    } elseif (-not (Would "run allow-lan.ps1 (rules scoped to LocalSubnet)")) {
        & powershell -ExecutionPolicy Bypass -File $script
    }
}

# ---------------------------------------------------------------------- done

Write-Host ""
if ($DryRun) { Warn "Dry run finished. Nothing was changed." } else { Say "Installed." 'Green' }
Write-Host ""
Write-Host "  server      http://${LanIp}:$Port"
Write-Host "  livekit     ws://${LanIp}:7880"
Write-Host "  console     cd `"$InstallDir\console`" && node src\main.mjs   -> http://127.0.0.1:4000"
Write-Host "  config      $envPath"
Write-Host ""
if (-not $NoStartup) {
    Write-Host "  Both tasks start on boot. To start them now without rebooting:"
    Write-Host "    Start-ScheduledTask -TaskName isthislegit-server"
    Write-Host "    Start-ScheduledTask -TaskName isthislegit-livekit"
    Write-Host ""
}
Write-Host "  Point the desktop client at http://${LanIp}:$Port and register with the"
Write-Host "  invite code the seed printed above."
Write-Host ""
