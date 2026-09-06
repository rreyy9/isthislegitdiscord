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

    # Install as a LAN-only server even when the payload carries a Caddyfile
    # with real hostnames. Without this, a payload whose Caddyfile names two
    # hosts is taken to be an internet deployment and configured for TLS.
    [switch] $LanOnly,

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

$here       = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir  = Join-Path $InstallDir 'server'
$lkDir      = Join-Path $InstallDir 'livekit'
$caddyDir   = Join-Path $InstallDir 'caddy'
$envPath    = Join-Path $serverDir '.env'

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

# Reads the hostnames back out of a Caddyfile, matched to the service each one
# proxies to rather than to the order they appear in. The Caddyfile is the only
# place a deployment's public names are written down, so this keeps them from
# having to be typed a second time -- and keeps them from drifting apart, which
# would present as voice connecting and staying silent.
#
# Returns $null when the file is missing or still has its placeholder names, so
# a payload built without a real Caddyfile installs LAN-only.
function Get-CaddyHosts([string] $path) {
    if (-not (Test-Path $path)) { return $null }

    $hosts = @{}
    $current = $null
    foreach ($line in (Get-Content $path)) {
        $trimmed = $line.Trim()
        if ($trimmed.StartsWith('#')) { continue }

        # A site block opens with the hostname it serves. Require a dot, so
        # snippet definitions like (tls443) and the global block are skipped.
        if ($trimmed -match '^([A-Za-z0-9][A-Za-z0-9.\-]*\.[A-Za-z]{2,})\s*\{') {
            $current = $Matches[1]
            continue
        }
        if ($trimmed -eq '}') { $current = $null; continue }

        if ($current -and $trimmed -match '^reverse_proxy\s+127\.0\.0\.1:(\d+)') {
            switch ($Matches[1]) {
                '3000' { $hosts['chat'] = $current }
                '7880' { $hosts['livekit'] = $current }
            }
        }
    }

    if ($hosts['chat'] -and $hosts['livekit']) { return $hosts }
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

# LAN or internet? Decided by the payload's own Caddyfile rather than by an
# answer someone has to type, because the hostnames are already written down
# there and a second copy is a second thing to get wrong.
$caddyHosts = if ($LanOnly) { $null } else { Get-CaddyHosts (Join-Path $here 'caddy\Caddyfile') }
$caddyExe   = Join-Path $caddyDir 'bin\caddy.exe'

if ($caddyHosts) {
    Say "  deployment   internet, behind TLS"
    Say "    chat       https://$($caddyHosts['chat'])"
    Say "    voice      wss://$($caddyHosts['livekit'])"
    if (-not (Test-Path (Join-Path $here 'caddy\bin\caddy.exe'))) {
        Warn "    caddy.exe is not in the payload -- nothing will answer on 443"
        Warn "    until it is dropped into $caddyDir\bin."
    }
} elseif ($LanOnly) {
    Say "  deployment   LAN only (-LanOnly)"
} else {
    Say "  deployment   LAN only (no Caddyfile with real hostnames in the payload)"
}

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
} elseif (-not (Would "copy server, shared, console, livekit and caddy")) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    foreach ($folder in @('server', 'shared', 'console', 'livekit', 'caddy', 'tray')) {
        $src = Join-Path $here $folder
        if (Test-Path $src) { Copy-Item $src $InstallDir -Recurse -Force }
    }
    foreach ($file in @('allow-lan.ps1', 'README.txt')) {
        $src = Join-Path $here $file
        if (Test-Path $src) { Copy-Item $src $InstallDir -Force }
    }
    if ($envBackup) { Set-Content $envPath $envBackup -Encoding ASCII -NoNewline }
}

# --------------------------------------------------------------- 2. PostgreSQL

# Settled before the database step, because setup-postgres.sql needs it and
# the .env that records it is not written until after. On an upgrade this is
# read back out of the existing .env, so nothing changes; on a fresh install it
# is generated, so two installs never share a database credential.
if (Test-Path $envPath) {
    $existingDbUrl = Get-EnvValue $envPath 'DATABASE_URL'
    if ($existingDbUrl -match '^postgres(?:ql)?://[^:]+:([^@]+)@') {
        $dbPassword = $Matches[1]
    } else {
        $dbPassword = $null
    }
} else {
    # Generated per install rather than shared. The old fixed value is
    # published in this project's repository, which made it a known password
    # for the application's database role on every box that ran this.
    # New-Secret is alphanumeric, so it needs no escaping inside DATABASE_URL.
    $dbPassword = New-Secret
}

Step "PostgreSQL"

# Every "do it by hand" message below has to carry app_password. Without it
# setup-postgres.sql falls back to the development password published in this
# repository, while .env holds the generated one -- and the two disagreeing
# presents as the server failing to reach a database that is plainly running.
$manualPsql = "psql -U postgres -v app_password=$dbPassword -f `"$serverDir\prisma\setup-postgres.sql`""

if ($SkipPostgres) {
    Warn "  skipped (-SkipPostgres). Apply it by hand as the postgres superuser:"
    Warn "    $manualPsql"
} elseif (-not $dbPassword) {
    # Only reachable on an upgrade whose DATABASE_URL could not be parsed. The
    # role and database already exist, so there is nothing this step has to do
    # -- and running it without a password would reset the role to the
    # published development one, which is worse than doing nothing.
    Warn "  skipped -- could not read the database password out of the existing"
    Warn "  DATABASE_URL, and the role must not be reset to the shared default."
    Warn "  The database already exists, so this is only a problem if it does not."
} elseif (-not $elevated -and -not $DryRun) {
    Warn "  skipped -- needs an elevated terminal. Re-run elevated, or apply it"
    Warn "  by hand as the postgres superuser:"
    Warn "    $manualPsql"
} else {
    $psql = (Get-Command psql -ErrorAction SilentlyContinue).Source
    if (-not $psql) {
        $candidate = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1
        if ($candidate) { $psql = $candidate.FullName }
    }

    if (-not $psql) {
        Warn "  psql.exe not found -- PostgreSQL does not appear to be installed."
        Warn "  This installer does not install it: it only creates the app's role"
        Warn "  and database inside a server that is already running. Install it,"
        Warn "    winget install PostgreSQL.PostgreSQL.17"
        Warn "  which asks you to set a superuser password, then run:"
        Warn "    $manualPsql"
    } elseif ($NonInteractive -and -not $PostgresPassword) {
        Warn "  skipped -- no postgres password was given and psql cannot prompt here."
        Warn "  Apply it by hand once, as the postgres superuser:"
        Warn "    $manualPsql"
    } else {
        Say "  using $psql"
        # setup-postgres.sql is written to be safe to re-run: the role is created
        # inside an IF NOT EXISTS block and the database behind a \gexec guard.
        if (-not (Would "run setup-postgres.sql")) {
            $previousPgPassword = $env:PGPASSWORD
            try {
                $psqlArgs = @('-U', 'postgres', '-f', (Join-Path $serverDir 'prisma\setup-postgres.sql'))

                # Without app_password the script falls back to the published
                # development password. Never let that happen on an install:
                # the guard above means we always have one to pass here.
                $psqlArgs = @('-v', "app_password=$dbPassword") + $psqlArgs

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

    # Behind Caddy the client is told a public wss:// address; on a LAN install
    # it is told this box directly. Either way the value reaches the client
    # from /api/config rather than being compiled into it, so it can change
    # here without anyone reinstalling anything.
    $livekitUrl = if ($caddyHosts) { "wss://$($caddyHosts['livekit'])" } else { "ws://${LanIp}:7880" }
    $authUrl    = if ($caddyHosts) { "https://$($caddyHosts['chat'])" } else { "http://${LanIp}:$Port" }

    $envText = @"
# Written by install.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm'). Secrets below
# were generated for this machine. Keep this file off any shared drive.
DATABASE_URL="postgres://chat_app:$dbPassword@localhost:5432/chat?schema=public"

BETTER_AUTH_SECRET="$authSecret"
BETTER_AUTH_URL="$authUrl"

PORT=$Port

LIVEKIT_URL="$livekitUrl"
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
        # Read as UTF-8 explicitly. Get-Content -Raw under Windows PowerShell
        # 5.1 decodes a BOM-less file as Windows-1252, so the em dashes in this
        # file's comments come back as mojibake and are then written back out
        # that way -- the same encoding trap that has already broken a .ps1 in
        # this repo. The write below is UTF-8 without a BOM; the read has to
        # agree with it.
        $yaml = [IO.File]::ReadAllText($lkYaml, (New-Object Text.UTF8Encoding($false)))

        # Which address LiveKit advertises in its ICE candidates. Media goes
        # straight to this box either way -- Caddy carries only the signalling
        # -- so behind TLS this still has to be the public address, discovered
        # by STUN at startup. Getting this wrong is the failure where everyone
        # joins the call, the UI shows them in the channel, and no audio ever
        # arrives.
        #
        # Done line by line rather than with -replace, because the file
        # documents both modes and so contains two use_external_ip lines, one
        # of them commented. A global replace would set both and hand LiveKit
        # a duplicate key, which it refuses to start on. The first occurrence
        # of each setting wins and any later one is commented out.
        $wantExternal = [bool] $caddyHosts
        $seenNodeIp = $false
        $seenExternal = $false

        $yaml = (($yaml -split "`r?`n") | ForEach-Object {
            if ($_ -match '^(\s*)#?\s*node_ip:') {
                $indent = $Matches[1]
                if ($seenNodeIp) { return "$indent# node_ip: $LanIp" }
                $seenNodeIp = $true
                # Under TLS the LAN address is kept as a comment, so the file
                # still records what it was if the deployment moves back.
                if ($wantExternal) { return "$indent# node_ip: $LanIp" }
                return "$indent" + "node_ip: $LanIp"
            }
            if ($_ -match '^(\s*)#?\s*use_external_ip:') {
                $indent = $Matches[1]
                # A later occurrence keeps its own text and is commented out.
                if ($seenExternal) { return ($_ -replace '^(\s*)#?\s*', '$1# ') }
                $seenExternal = $true
                return "$indent" + "use_external_ip: " + $(if ($wantExternal) { 'true' } else { 'false' })
            }
            return $_
        }) -join "`r`n"

        # `\s*$` on the end would swallow the newline and the blank line after
        # the keys block, closing the comment that follows up against it. Match
        # trailing spaces and tabs only, and leave the line ending alone.
        $yaml = $yaml -replace '(?m)^(\s*)API[0-9a-zA-Z]+:[ \t]*\S+[ \t]*$', "`${1}${lkKey}: $lkSecret"
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
        if ($LASTEXITCODE -ne 0) {
            # Overwhelmingly the cause: the PostgreSQL step above was skipped,
            # so the chat_app role this connects as was never created. That
            # error arrives as an authentication failure against a database
            # that is plainly running, which reads as a configuration mystery
            # rather than a step that did not happen.
            Warn ""
            Warn "  If that was an authentication or 'role does not exist' error, the"
            Warn "  PostgreSQL step above did not run. Do it now, as the superuser:"
            Warn "    $manualPsql"
            Warn "  then re-run this installer -- it is safe to run again."
            throw "prisma migrate deploy failed (exit $LASTEXITCODE)"
        }
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

    # Caddy only on an internet deployment: on a LAN install there is no
    # hostname to get a certificate for, and it would sit retrying forever.
    if ($caddyHosts) {
        $caddyExeCheck = if ($DryRun) { Join-Path $here 'caddy\bin\caddy.exe' } else { $caddyExe }
        $tasks += @{
            Name  = 'isthislegit-caddy'
            Exe   = $caddyExe
            Args  = "run --config `"$caddyDir\Caddyfile`" --adapter caddyfile"
            Dir   = $caddyDir
            Check = $caddyExeCheck
        }
    }

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
if ($caddyHosts) {
    Write-Host "  server      https://$($caddyHosts['chat'])"
    Write-Host "  livekit     wss://$($caddyHosts['livekit'])"
    Write-Host "              (both on this box as http://${LanIp}:$Port and ws://${LanIp}:7880)"
} else {
    Write-Host "  server      http://${LanIp}:$Port"
    Write-Host "  livekit     ws://${LanIp}:7880"
}
Write-Host "  console     cd `"$InstallDir\console`" && node src\main.mjs   -> http://127.0.0.1:4000"
Write-Host "  config      $envPath"
Write-Host ""
if (-not $NoStartup) {
    Write-Host "  The tasks start on boot. To start them now without rebooting:"
    Write-Host "    Start-ScheduledTask -TaskName isthislegit-server"
    Write-Host "    Start-ScheduledTask -TaskName isthislegit-livekit"
    if ($caddyHosts) {
        Write-Host "    Start-ScheduledTask -TaskName isthislegit-caddy"
    }
    Write-Host ""
}

if ($caddyHosts) {
    Write-Host "  Point the desktop client at https://$($caddyHosts['chat']) and register"
    Write-Host "  with the invite code the seed printed above."
    Write-Host ""
    Write-Host "  Still to do by hand, and nothing reaches this box without them:" -ForegroundColor Yellow
    Write-Host "    1. Forward 443/tcp, 7881/tcp, 3478/udp and 50000-50100/udp on the"
    Write-Host "       router to $LanIp. Do not forward 3000 or 7880 -- Caddy reaches"
    Write-Host "       both over loopback, and forwarding them would republish the same"
    Write-Host "       two services with no TLS in front."
    Write-Host "    2. Open the firewall:  powershell -File `"$InstallDir\allow-lan.ps1`" -Internet"
    Write-Host "    3. Check both hostnames resolve to this connection's public address."
    Write-Host ""
    Write-Host "  Caddy fetches its certificates on first start. Give it a few seconds,"
    Write-Host "  then check https://$($caddyHosts['chat'])/api/health from outside."
} else {
    Write-Host "  Point the desktop client at http://${LanIp}:$Port and register with the"
    Write-Host "  invite code the seed printed above."
}
Write-Host ""
