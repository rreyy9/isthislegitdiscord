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

    # Update an install that is already here, instead of configuring a fresh
    # one. The payload next to this script is staged rather than live, and only
    # the components whose contents actually changed are moved into place --
    # with the services that read them stopped for as short a time as that
    # takes, and the ones that read nothing that changed left running. See "the
    # update path" below.
    #
    # The NSIS installer passes this when it finds an existing install. Passing
    # it by hand against a box that has never been installed fails early and
    # says so, rather than half-configuring one.
    [switch] $Update,

    # Seconds to wait for /api/health after starting the server back up. Past
    # this the update is treated as failed and rolled back.
    [int] $HealthTimeout = 90,

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

# ------------------------------------------------------------- the admin app
#
# "isthislegit Server" (apps/server-app) is a shell around the operator console
# rather than a second copy of it: it spawns console\src\main.mjs with its
# working directory set to console\ (apps/server-app/src/main.js). On Windows a
# process's current directory is an open handle on that directory, and a
# directory with an open handle cannot be renamed -- which is exactly how the
# update path swaps a component into place. So an update that touches console\
# failed, every time, on any box where the operator was watching it through the
# app: "the process cannot access the file because it is being used by another
# process", thrown after 224 MB of server\node_modules had already moved and
# had to be moved back.
#
# app\ is the same problem twice over: 319 MB of Electron with the running
# executable inside it. That one used to be skipped rather than fail, which
# meant the admin app silently never updated at all.
#
# Both are answered the same way -- close the app for the length of the swap,
# open it again after. It supervises; it does not serve. Nobody using the chat
# server notices.
#
# The console runs on Electron's own Node (ELECTRON_RUN_AS_NODE), so it appears
# under this same process name: closing "isthislegit Server" means both.
$adminAppProcess = 'isthislegit Server'

function Get-AdminApp {
    @(Get-Process -Name $adminAppProcess -ErrorAction SilentlyContinue)
}

# Read before the app is closed, so it can be opened again from where it
# actually was. On an install that is always $InstallDir\app; a developer
# running the unpacked build somewhere else is worth not breaking.
function Get-AdminAppPath {
    foreach ($p in (Get-AdminApp)) {
        try { if ($p.Path) { return $p.Path } } catch { }
    }
    $fallback = Join-Path $InstallDir 'app\isthislegit Server.exe'
    if (Test-Path $fallback) { return $fallback }
    return $null
}

# Any process whose command line names the console entry point. A force-killed
# app leaves its console behind, and an orphaned console holds console\ open
# just as effectively as the app did.
function Stop-ConsoleStrays {
    $strays = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'console[\\/]src[\\/]main\.mjs' })
    foreach ($proc in $strays) {
        Say "    ending the operator console (pid $($proc.ProcessId))"
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

# Ask first, insist after. CloseMainWindow lets the app run its own before-quit,
# which taskkills the console tree -- that is what actually releases console\,
# and it releases it cleanly. Only a window that will not go gets ended.
#
# Returns whether anything was closed, which is the question the caller has:
# an app that was not open must not be opened by an update.
function Stop-AdminApp {
    $running = Get-AdminApp
    if (-not $running) { return $false }

    Say "    asking $adminAppProcess to close ($($running.Count) process(es))"
    foreach ($p in $running) {
        try { $p.CloseMainWindow() | Out-Null } catch { }
    }

    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline -and (Get-AdminApp)) { Start-Sleep -Milliseconds 200 }

    if (Get-AdminApp) {
        Warn "    it did not close on its own -- ending it"
        foreach ($p in (Get-AdminApp)) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 500
    }

    Stop-ConsoleStrays
    Start-Sleep -Milliseconds 500

    if (Get-AdminApp) {
        throw "$adminAppProcess would not close, and console\ and app\ cannot be replaced while it is running. Close it and run the installer again."
    }
    Say "    closed"
    return $true
}

function Start-AdminApp([string] $exe) {
    if (-not $exe) {
        Warn "    could not tell where the admin app lives -- open it yourself"
        return
    }
    if (-not (Test-Path $exe)) {
        Warn "    $exe is not there -- open the admin app yourself"
        return
    }
    try {
        Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) | Out-Null
        Say "    reopened the admin app"
    } catch {
        Warn "    could not reopen the admin app -- open it yourself. $($_.Exception.Message)"
    }
}

# ------------------------------------------------------ Caddy's certificates
#
# Caddy keeps its certificates and its ACME account in a per-account data
# directory -- %AppData%\Caddy -- which is a different folder for SYSTEM, who
# runs the scheduled task, than for whoever is logged in, who is who the
# operator console starts Caddy as when there is no task to drive. Started one
# way and then the other, Caddy finds an empty store the second time and
# re-issues both certificates. Let's Encrypt allows five duplicate certificates
# a week per set of names, which is not many if the store moves on every
# restart.
#
# Pinning storage under the install directory makes the store the deployment's
# rather than the account's, so it does not matter who starts Caddy.
#
# Written into the installed Caddyfile rather than shipped in the template
# because caddy-config is staged and never overwritten -- an operator's edited
# Caddyfile is the one Caddy actually reads, and it is the one that has to end
# up with the directive. The template cannot carry it anyway: it does not know
# the install directory.
function Set-CaddyStorage([string] $caddyfile, [string] $dataDir) {
    if (-not (Test-Path $caddyfile)) { return }

    if ((Get-Content $caddyfile -Raw) -match '(?m)^\s*storage\s') {
        Say "  certificate store already pinned in $caddyfile"
        return
    }

    # The global block is the one that opens with a bare '{' on a line of its
    # own. Snippets and site blocks all have a name in front of theirs.
    $lines  = @(Get-Content $caddyfile)
    $insert = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i].Trim() -eq '{') { $insert = $i; break }
    }

    $block = @(
        "`tstorage file_system {"
        "`t`troot `"$dataDir`""
        "`t}"
    )

    if ($insert -ge 0) {
        $head = @($lines[0..$insert])
        $tail = if ($insert -lt $lines.Count - 1) { @($lines[($insert + 1)..($lines.Count - 1)]) } else { @() }
        $out  = $head + $block + $tail
    } else {
        # No global block at all: open one at the top, which is where Caddy
        # requires it to be.
        $out = @('{') + $block + @('}', '') + $lines
    }

    Copy-Item $caddyfile "$caddyfile.bak" -Force
    Set-Content -Path $caddyfile -Value $out -Encoding UTF8
    Say "  pinned the certificate store to $dataDir"
    Say "  kept the previous Caddyfile as $(Split-Path -Leaf $caddyfile).bak"
}

# Bring whatever Caddy already issued into the pinned store, so pinning it costs
# nothing. SYSTEM's profile first: that is where the scheduled task's Caddy put
# them, and on this deployment the task is how Caddy has always run.
function Copy-CaddyStore([string] $dataDir) {
    if (Test-Path (Join-Path $dataDir 'certificates')) { return }

    foreach ($candidate in @(
        (Join-Path $env:SystemRoot 'System32\config\systemprofile\AppData\Roaming\Caddy'),
        (Join-Path $env:AppData 'Caddy')
    )) {
        if (-not $candidate) { continue }
        if (-not (Test-Path (Join-Path $candidate 'certificates'))) { continue }
        New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
        Copy-Item (Join-Path $candidate '*') $dataDir -Recurse -Force
        Say "  copied the existing certificates in from $candidate"
        Say "  (nothing is re-issued, so no Let's Encrypt rate limit is spent)"
        return
    }
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

# ========================================================== the update path
#
# Everything below, down to the "end of the update path" marker, runs instead
# of the fresh install rather than before it, and then exits.
#
# The shape of it:
#
#   1. diff the payload's manifest against the one this install recorded, and
#      work out the shortest list of components that actually have to move;
#   2. do everything expensive -- unpack, verify, decide -- with the server
#      still serving. The NSIS installer has already unpacked into
#      $InstallDir\.update by the time this runs;
#   3. stop only the services that read something that changed;
#   4. rename directories into place. On one volume that is a metadata
#      operation, so the stop window is a service restart and not a 617 MB
#      copy;
#   5. migrate, start, and wait for /api/health;
#   6. put the previous version back if that never comes.
#
# What this cannot undo is a migration: Prisma has no down migrations, so a
# rollback restores the code against an already-migrated database. That is only
# safe while migrations stay additive -- new nullable columns and new tables,
# with drops left to a later release once no version still running reads them.

if ($Update) {

    Step "Updating an existing install"

    # --------------------------------------- what changed, and what did not

    $payloadManifestPath   = Join-Path $here 'payload.json'
    $installedManifestPath = Join-Path $InstallDir 'installed.json'

    if (-not (Test-Path $payloadManifestPath)) {
        throw "There is no payload.json next to this script. This payload was built before the installer tracked components -- rebuild it with the current build-server-installer.ps1, or install it as a fresh install without -Update."
    }
    if (-not (Test-Path (Join-Path $serverDir 'dist\main.js'))) {
        throw "$InstallDir does not hold an install of this server (no server\dist\main.js). Run without -Update."
    }

    $payloadManifest = Get-Content $payloadManifestPath -Raw | ConvertFrom-Json

    $installedHashes  = @{}
    $installedVersion = '(unrecorded)'
    if (Test-Path $installedManifestPath) {
        $installed = Get-Content $installedManifestPath -Raw | ConvertFrom-Json
        $installedVersion = $installed.version
        foreach ($p in $installed.components.PSObject.Properties) {
            $installedHashes[$p.Name] = $p.Value.hash
        }
    } else {
        Warn "  no installed.json -- this install predates component tracking."
        Warn "  Everything in the payload is replaced this once; the next update will be short."
    }

    Say "  installed    $installedVersion"
    Say "  payload      $($payloadManifest.version)"
    Say "  staged in    $here"

    # What each component means for the running services. Anything not named
    # here restarts the chat server: it reads most of the payload, so it is the
    # answer that is wrong in the harmless direction if a component is added to
    # the build script and not to this table.
    #
    #   Restart   which service has to come down and back up
    #   Migrate   a change here means new migrations shipped
    #   Stage     do not overwrite the installed copy; write it alongside
    #   NeedsApp  the admin app has to be closed before this can be replaced
    $policy = @{
        'server-dist'    = @{ Restart = 'server' }
        'server-prisma'  = @{ Restart = 'server'; Migrate = $true }
        'server-deps'    = @{ Restart = 'server' }
        'shared'         = @{ Restart = 'server' }

        # The console's *files* are read at startup and held open by nothing
        # afterwards, which is what this used to say and is why it was marked
        # replaceable under a running app. The *directory* is another matter:
        # it is the admin app's working directory for the console it spawns,
        # and Windows will not rename a directory that is some process's cwd.
        # So the app closes for this. Nothing serving stops -- the console
        # supervises, it does not serve.
        'console'        = @{ Restart = 'none'; NeedsApp = $true; Note = 'the admin app closes for this and is reopened after' }

        # Restarting LiveKit drops every call in progress, which is why the
        # binary is hashed apart from anything else: it moves only when someone
        # deliberately bumps it, so most updates never touch voice at all.
        'livekit-bin'    = @{ Restart = 'livekit' }

        # start.ps1, and only start.ps1 -- livekit.yaml is not tracked, see the
        # build script. The scheduled task runs the binary directly and never
        # reads this, so replacing it changes nothing until somebody starts
        # LiveKit by hand. Dropping every call in progress to pick up a script
        # that is not in the running path would be a poor trade.
        'livekit-config' = @{ Restart = 'none'; Note = 'used only for starting LiveKit by hand; nothing was restarted for it' }

        'caddy-bin'      = @{ Restart = 'caddy' }

        # The installed Caddyfile is this deployment's, and may have been edited
        # on the box. Overwriting it could change the hostnames the server is
        # reached on, so the new one is written beside it and left to a human.
        'caddy-config'   = @{ Restart = 'none'; Stage = $true; Note = 'written as Caddyfile.new; the live one is untouched' }

        # 319 MB of Electron with the running executable inside it. This was
        # skipped whenever the app was open, and on a box where the operator
        # watches the update through that app it was open every time -- so the
        # admin app never actually updated, and the only sign of it was a line
        # in the details list. Closed for the swap and reopened after, like the
        # console.
        'app'            = @{ Restart = 'none'; NeedsApp = $true; Note = 'the admin app closes for this and is reopened after' }

        'scripts'        = @{ Restart = 'none' }
    }

    $changed   = New-Object System.Collections.Generic.List[object]
    $sameCount = 0
    $sameBytes = [long] 0

    foreach ($p in $payloadManifest.components.PSObject.Properties) {
        $name = $p.Name
        if ($installedHashes[$name] -eq $p.Value.hash) {
            $sameCount++
            $sameBytes += [long] $p.Value.bytes
            continue
        }

        $rule = $policy[$name]
        if (-not $rule) {
            Warn "  $name is not in this script's policy table -- assuming it needs the chat server restarted."
            $rule = @{ Restart = 'server' }
        }

        $changed.Add([pscustomobject] @{
            Name     = $name
            Paths    = @($p.Value.paths)
            Bytes    = [long] $p.Value.bytes
            Restart  = $rule.Restart
            Migrate  = [bool] $rule.Migrate
            Stage    = [bool] $rule.Stage
            NeedsApp = [bool] $rule.NeedsApp
            Note     = $rule.Note
        })
    }

    Say ""
    if ($changed.Count -eq 0) {
        Say "Nothing in this payload differs from what is installed." 'Green'
        Say "  No service was stopped."
        if (-not $DryRun) { Copy-Item $payloadManifestPath $installedManifestPath -Force }
        Write-Host ""
        exit 0
    }

    Say "  replacing:"
    foreach ($c in $changed) {
        $suffix = if ($c.Note) { "  -- $($c.Note)" } else { "  restart: $($c.Restart)" }
        Say ("    {0,-15} {1,7:N1} MB{2}" -f $c.Name, ($c.Bytes / 1MB), $suffix)
    }
    if ($sameCount -gt 0) {
        Say ("  unchanged, not unpacked and not restarted: {0} components, {1:N0} MB" -f $sameCount, ($sameBytes / 1MB))
    }

    # Migrations run when the schema component moved, which is the same thing as
    # "this release shipped new migrations". Asking Prisma instead would mean a
    # round trip to the database to learn what the build already knows.
    $needsMigrate = (@($changed | Where-Object { $_.Migrate }).Count -gt 0) -or -not (Test-Path $installedManifestPath)

    # Restarting is keyed off the components, so a payload that only moves the
    # admin app never stops anything.
    $toRestart = @($changed | ForEach-Object { $_.Restart } | Where-Object { $_ -ne 'none' } | Sort-Object -Unique)

    # Closing the admin app is decided the same way restarting is: off the
    # components. An update that only moves server\dist leaves it open.
    $closesApp = @($changed | Where-Object { $_.NeedsApp }).Count -gt 0

    $migrateLabel = if ($needsMigrate) { 'yes' } else { 'no -- the schema did not change' }
    $restartLabel = if ($toRestart) { $toRestart -join ', ' } else { 'nothing' }
    $appLabel     = if ($closesApp) { 'closed for the swap, reopened after' } else { 'left open' }

    Say ""
    Say "  migrations   $migrateLabel"
    Say "  restarting   $restartLabel"
    Say "  admin app    $appLabel"

    if ((Split-Path -Qualifier $here) -ne (Split-Path -Qualifier $InstallDir)) {
        Warn ""
        Warn "  The payload is on $(Split-Path -Qualifier $here) and the install is on $(Split-Path -Qualifier $InstallDir)."
        Warn "  Across volumes a move is a copy, so the services stay down for the"
        Warn "  length of it rather than for a restart. Stage under $InstallDir instead."
    }

    if ($DryRun) {
        Write-Host ""
        Warn "Dry run finished. Nothing was stopped, moved or migrated."
        Write-Host ""
        exit 0
    }

    # ------------------------------------------------------------ machinery

    $rollbackDir = Join-Path $InstallDir '.rollback'
    if (Test-Path $rollbackDir) { Remove-Item $rollbackDir -Recurse -Force }
    New-Item -ItemType Directory -Path $rollbackDir -Force | Out-Null

    $moved = New-Object System.Collections.Generic.List[object]

    function Get-PortOwner([int] $port) {
        try {
            @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop |
                Select-Object -ExpandProperty OwningProcess -Unique)
        } catch {
            @()
        }
    }

    # Stopping one of the three services, whichever way it happens to have been
    # started.
    #
    # The scheduled task is only half of it. The operator console spawns the
    # server, LiveKit and Caddy as its own children (apps/console/src/main.mjs),
    # so on a box where someone pressed Start in the admin app there is no task
    # running to stop, and the process holding server\dist open is a child of
    # the console. Ending the task alone there leaves the files locked, and the
    # rename below fails with an access denied that reads as a permissions
    # problem rather than as a process nobody stopped.
    #
    # So: ask the task to end, wait for the port to go quiet, and only then take
    # whatever still holds it by force.
    function Stop-Managed([string] $task, [int] $port, [string] $label, [int] $graceSeconds = 20) {
        if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
            Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
        }

        $deadline = (Get-Date).AddSeconds($graceSeconds)
        while ((Get-Date) -lt $deadline -and (Get-PortOwner $port)) { Start-Sleep -Milliseconds 200 }

        $owners = Get-PortOwner $port
        if ($owners) {
            Say "    $label is still on port $port -- stopping pid $($owners -join ', ')"
            foreach ($owner in $owners) { Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue }
            $deadline = (Get-Date).AddSeconds(10)
            while ((Get-Date) -lt $deadline -and (Get-PortOwner $port)) { Start-Sleep -Milliseconds 200 }
        }

        if (Get-PortOwner $port) {
            throw "$label is still listening on port $port. Nothing has been changed yet -- stop it and run this again."
        }
        Say "    stopped $label"
    }

    function Start-Managed([string] $task, [string] $label) {
        if (-not (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue)) {
            Warn "    there is no $task task -- start $label yourself"
            return
        }
        Start-ScheduledTask -TaskName $task
        Say "    started $label"
    }

    function Wait-Healthy([string] $url, [int] $timeoutSeconds) {
        $deadline = (Get-Date).AddSeconds($timeoutSeconds)
        while ((Get-Date) -lt $deadline) {
            try {
                if ((Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200) { return $true }
            } catch {
                # Not up yet, or not coming up at all. The loop decides which.
            }
            # A second between tries, not a tight loop: ThrottlerGuard is
            # registered globally (apps/server/src/app.module.ts) and a hammered
            # /api/health answers 429, which is indistinguishable here from a
            # server that never came up.
            Start-Sleep -Seconds 1
        }
        return $false
    }

    # Directories are moved, files are copied. The move is the point -- within
    # one volume it is a rename, and that is what keeps the stop window to the
    # length of a restart instead of the length of a 193 MB copy. Files are
    # copied because install.ps1 is one of them, and a script cannot be renamed
    # out from under itself while it runs.
    function Move-Component([string] $relPath, [bool] $stageOnly) {
        $live   = Join-Path $InstallDir $relPath
        $staged = Join-Path $here $relPath

        if (-not (Test-Path $staged)) {
            Warn "    $relPath is in the manifest but not in the payload -- skipped"
            return
        }

        if ($stageOnly) {
            Copy-Item $staged "$live.new" -Recurse -Force
            Say "    $relPath -> $relPath.new"
            return
        }

        $saved = Join-Path $rollbackDir $relPath
        New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force | Out-Null

        $hadLive = Test-Path $live
        if ($hadLive) { Move-Item $live $saved -Force }

        $parent = Split-Path -Parent $live
        if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }

        if ((Get-Item $staged -Force).PSIsContainer) {
            Move-Item $staged $live -Force
        } else {
            Copy-Item $staged $live -Force
        }

        $moved.Add([pscustomobject] @{ Live = $live; Saved = $saved; HadLive = $hadLive })
        Say "    $relPath"
    }

    # Newest first, so a half-finished swap unwinds in the order it was made.
    function Undo-Moves {
        for ($i = $moved.Count - 1; $i -ge 0; $i--) {
            $m = $moved[$i]
            try {
                if (Test-Path $m.Live) { Remove-Item $m.Live -Recurse -Force }
                if ($m.HadLive) { Move-Item $m.Saved $m.Live -Force }
            } catch {
                Warn "    could not restore $($m.Live) -- $($_.Exception.Message)"
            }
        }
    }

    $installedPort = Get-EnvValue $envPath 'PORT'
    if (-not $installedPort) { $installedPort = $Port }
    $healthUrl = "http://127.0.0.1:$installedPort/api/health"

    $ports = @{ server = [int] $installedPort; livekit = 7880; caddy = 443 }
    $tasks = @{ server = 'isthislegit-server'; livekit = 'isthislegit-livekit'; caddy = 'isthislegit-caddy' }

    # Pinning the certificate store is version-independent and additive, so it
    # happens outside the window and is deliberately not rolled back: it is
    # correct on the old version as well as the new one. Caddy reads it at its
    # next start, which is this update's restart when caddy is in $toRestart and
    # the next reboot otherwise.
    if ($caddyHosts) {
        Step "Caddy's certificate store"
        Copy-CaddyStore (Join-Path $caddyDir 'data')
        Set-CaddyStorage (Join-Path $caddyDir 'Caddyfile') (Join-Path $caddyDir 'data')
        if ($toRestart -notcontains 'caddy') {
            Say "  Caddy was not restarted for this update, so it picks this up at its next start."
        }
    }

    # ------------------------------------------------------ the short window

    $startedAt  = Get-Date
    $appExePath = $null
    $appWasOpen = $false

    try {
        # Before the services, not after: closing the app takes the operator
        # console with it, and on a box where somebody pressed Start in the app
        # the console is the parent of the server, LiveKit and Caddy. Doing this
        # first means Stop-Managed below usually finds the ports already quiet.
        if ($closesApp) {
            Step "Closing the admin app"
            $appExePath = Get-AdminAppPath
            $appWasOpen = Stop-AdminApp
            if (-not $appWasOpen) { Say "    it was not open" }
        }

        if ($toRestart) {
            Step "Stopping"
            foreach ($svc in $toRestart) { Stop-Managed $tasks[$svc] $ports[$svc] $svc }
        }

        Step "Swapping components into place"
        foreach ($c in $changed) {
            # Stop-AdminApp already threw if it could not close the app, so this
            # should never fire. It stays because the alternative is discovering
            # the lock halfway through the swap, which means moving 224 MB of
            # node_modules back -- and that is the failure this release fixes.
            if ($c.NeedsApp -and (Get-AdminApp)) {
                throw "$($c.Name) cannot be replaced while $adminAppProcess is running. Close it and run the installer again."
            }
            foreach ($relPath in $c.Paths) { Move-Component $relPath $c.Stage }
        }

        if ($needsMigrate) {
            Step "Applying migrations"
            Push-Location $serverDir
            try {
                & npx --no-install prisma migrate deploy
                if ($LASTEXITCODE -ne 0) { throw "prisma migrate deploy failed (exit $LASTEXITCODE)" }
            } finally { Pop-Location }
        }

        if ($toRestart) {
            Step "Starting"
            foreach ($svc in $toRestart) { Start-Managed $tasks[$svc] $svc }
        }

        if ($toRestart -contains 'server') {
            Step "Waiting for the server"
            Say "  $healthUrl"
            if (-not (Wait-Healthy $healthUrl $HealthTimeout)) {
                throw "the server did not answer /api/health within $HealthTimeout seconds"
            }
            Say "  healthy"
        }
    } catch {
        $reason = $_.Exception.Message
        Write-Host ""
        Warn "The update failed: $reason"
        Warn "Putting the previous version back."

        foreach ($svc in $toRestart) {
            try { Stop-Managed $tasks[$svc] $ports[$svc] $svc 10 } catch { Warn "    $($_.Exception.Message)" }
        }
        Undo-Moves
        foreach ($svc in $toRestart) { Start-Managed $tasks[$svc] $svc }

        # The operator was watching through this, and a rollback is exactly when
        # they want it back. Undo-Moves has already put the old app\ back, so
        # this reopens the version that was running before.
        if ($appWasOpen) { Start-AdminApp $appExePath }

        Write-Host ""
        Warn "Rolled back to $installedVersion. The install is as it was, with one exception:"
        Warn "any migration that ran is still applied -- Prisma has no down migrations."
        Warn "installed.json was not changed, so running this installer again retries the same update."
        Write-Host ""
        throw "update failed and was rolled back: $reason"
    }

    # Measured before the app is reopened: Electron taking a few seconds to
    # paint is not the chat server being unavailable, and this number is the one
    # that gets quoted.
    $downSeconds = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)

    if ($appWasOpen) {
        Step "Reopening the admin app"
        Start-AdminApp $appExePath
    }

    # Only now, once the server has answered, is the new manifest the truth.
    Copy-Item $payloadManifestPath $installedManifestPath -Force
    if ($elevated) {
        New-Item -Path 'HKLM:\Software\isthislegit\server' -Force | Out-Null
        Set-ItemProperty -Path 'HKLM:\Software\isthislegit\server' -Name 'Version' -Value $payloadManifest.version
    }

    # Outside the window on purpose: deleting the old node_modules is thousands
    # of files, and there is no reason for the server to be down for it.
    Step "Cleaning up"
    try {
        Remove-Item $rollbackDir -Recurse -Force -ErrorAction Stop
        Say "  removed $rollbackDir"
    } catch {
        Warn "  could not remove $rollbackDir -- delete it by hand. $($_.Exception.Message)"
    }

    Write-Host ""
    Say "Updated $installedVersion -> $($payloadManifest.version)." 'Green'
    Write-Host ""
    Write-Host "  services were down for $downSeconds seconds"
    Write-Host "  restarted    $restartLabel"
    if ($sameCount -gt 0) {
        Write-Host ("  left alone   {0} components, {1:N0} MB" -f $sameCount, ($sameBytes / 1MB))
    }
    if ($toRestart -notcontains 'livekit') {
        Write-Host "  voice        untouched -- calls in progress were not interrupted"
    }
    foreach ($c in $changed) {
        if ($c.Note) { Write-Host "  $($c.Name): $($c.Note)" }
    }
    Write-Host ""
    exit 0
}

# ==================================================== end of the update path

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

# Within one volume a move is a rename, and the payload is more than thirty
# thousand files. The NSIS installer now unpacks into $InstallDir\.update
# instead of straight into $InstallDir -- it has to, so that an update can stage
# a new version beside the running one -- and that would have made every fresh
# install pay for a second full copy of 617 MB. Renaming instead costs nothing.
$sameVolume = (Split-Path -Qualifier $here) -ieq (Split-Path -Qualifier $InstallDir)
$verb = if ($sameVolume) { 'move' } else { 'copy' }

if ($inPlace) {
    Say "  payload is already in place -- nothing to copy"
} elseif (-not (Would "$verb server, shared, console, livekit, caddy and app into place")) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    foreach ($folder in @('server', 'shared', 'console', 'livekit', 'caddy', 'app')) {
        $src = Join-Path $here $folder
        if (-not (Test-Path $src)) { continue }
        if ($sameVolume) {
            # Move-Item will not merge onto a folder that is already there, and
            # a fresh install run over an old one has to end up with the new
            # tree rather than the union of both. .env is put back below, from
            # the copy taken above.
            $dest = Join-Path $InstallDir $folder
            if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
            Move-Item $src $dest -Force
        } else {
            Copy-Item $src $InstallDir -Recurse -Force
        }
    }
    # These are copied whichever volume they are on. install.ps1 is the script
    # running right now, which cannot be renamed out from under itself, and
    # payload.json is wanted in both places -- here to be read at the end of
    # this run, and in the install dir as the baseline the next update diffs
    # against.
    foreach ($file in @('allow-lan.ps1', 'start-all.ps1', 'README.txt', 'install.ps1', 'payload.json')) {
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

    # A key added to the template after this .env was written never reaches an
    # upgraded install: the file is restored verbatim during the copy step, on
    # purpose, because it holds this deployment's generated secrets. That is
    # right for secrets and wrong for a path the server has no usable default
    # for. LOG_DIR unset means logs land a level above the install directory,
    # where the console cannot find them, so its Logs tab stays empty on every
    # box that upgraded rather than installed fresh.
    #
    # Appended, never rewritten. The one key that is missing is added at the
    # end of the file and nothing else in it is touched.
    if (-not (Get-EnvValue $envPath 'LOG_DIR')) {
        $logDir = "$($InstallDir -replace '\\', '/')/data/logs"
        if (-not (Would "add LOG_DIR=$logDir to the existing .env")) {
            $addition = "`r`n`r`n# Added by install.ps1: where the server writes its logs, and where the`r`n" +
                        "# operator console looks for them to fill its Logs tab.`r`nLOG_DIR=`"$logDir`""
            Add-Content $envPath $addition -Encoding ASCII -NoNewline
        }
        Say "  added LOG_DIR to the existing .env -- $logDir"
    }
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

# The desktop client's update feed, for the same reason. The console
# publishes builds into it and the server serves them from there.
UPDATES_DIR="$($InstallDir -replace '\\', '/')/data/updates"

# The server log files, for the same reason again -- and this one is not only
# about tidiness. The operator console tails these to fill its Logs tab, and
# it finds them by reading this key. Left unset, the server writes them to
# cwd\..\..\data\logs, which from server\ is one level above the
# install directory, so the console looks inside the install and finds none.
LOG_DIR="$($InstallDir -replace '\\', '/')/data/logs"

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

            # The key pair, and the webhook that has to name the same key.
            #
            # Line by line for the same reason as above, and for one more: a
            # multiline -replace anchored with $ has to account for the \r of a
            # CRLF file, and getting that wrong fails silently -- the pattern
            # simply never matches, the placeholder ships, and LiveKit starts
            # with a config that cannot mint or verify a token. Splitting on
            # newlines first means no pattern here ever sees a line ending.
            #
            # `api_key` does not collide with the key-entry pattern: an
            # underscore is not in [0-9a-zA-Z], so `api_key:` cannot match it.
            if ($_ -match '^(\s*)API[0-9a-zA-Z]+:\s*\S+\s*$') {
                return "$($Matches[1])${lkKey}: $lkSecret"
            }
            if ($_ -match '^(\s*)api_key:') {
                return "$($Matches[1])api_key: $lkKey"
            }
            if ($_ -match '^(\s*)-\s*https?://\S*?/api/livekit/webhook\s*$') {
                return "$($Matches[1])- http://127.0.0.1:$Port/api/livekit/webhook"
            }

            return $_
        }) -join "`r`n"
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

# ------------------------------------------------- 4b. Caddy's certificates

# Done on the fresh path too, and not only on updates: a first install that is
# started once through the app and thereafter by the task would otherwise issue
# its certificates twice for no reason. See Set-CaddyStorage.
if ($caddyHosts -and -not $DryRun) {
    Step "Caddy's certificate store"
    Copy-CaddyStore (Join-Path $caddyDir 'data')
    Set-CaddyStorage (Join-Path $caddyDir 'Caddyfile') (Join-Path $caddyDir 'data')
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

        $action = New-ScheduledTaskAction -Execute $t.Exe -Argument $t.Args -WorkingDirectory $t.Dir

        # A bare -AtStartup trigger fires before the network stack is up and
        # before PostgreSQL is listening. That matters because neither service
        # tolerates it: PrismaService.onModuleInit calls $connect()
        # (apps/server/src/prisma/prisma.service.ts), so the chat server exits
        # non-zero against a database that has not finished starting, and
        # Caddy's ACME fails on a box with no address yet.
        #
        # Scheduled tasks cannot express "after the postgresql service", so the
        # two things that can be done are done: wait before the first try, and
        # keep trying for long enough to outlast a slow boot. Three restarts a
        # minute apart was not long enough -- a cold boot burns through all
        # three while Postgres is still coming up, the task gives up for good,
        # and what the operator sees is "the tasks do not work after a reboot,
        # but starting them by hand afterwards works fine". That is the whole
        # of that bug.
        $trigger       = New-ScheduledTaskTrigger -AtStartup
        $trigger.Delay = 'PT45S'

        $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

        Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $trigger `
            -Principal $principal -Settings $settings | Out-Null
        Say "  registered $($t.Name)"
    }
}

# ----------------------------------------------------------------- 5b. shortcuts

# The app is the thing anyone opens day to day, so it gets a shortcut in both
# places people look. Made here rather than by NSIS because install.ps1 also
# runs standalone, from the zip.
$appExe = Join-Path $InstallDir 'app\isthislegit Server.exe'
if (Test-Path $appExe) {
    Step "Shortcuts"
    if (-not (Would "add Start Menu and desktop shortcuts for the admin app")) {
        $shell = New-Object -ComObject WScript.Shell
        foreach ($dir in @(
            [Environment]::GetFolderPath('Programs'),
            [Environment]::GetFolderPath('Desktop')
        )) {
            if (-not $dir) { continue }
            try {
                $lnk = $shell.CreateShortcut((Join-Path $dir 'isthislegit Server.lnk'))
                $lnk.TargetPath = $appExe
                $lnk.WorkingDirectory = Join-Path $InstallDir 'app'
                $lnk.Description = 'Administer the isthislegit server'
                $lnk.Save()
                Say "  $dir"
            } catch {
                Warn "  could not write a shortcut in $dir -- $($_.Exception.Message)"
            }
        }
    }
} elseif (-not $DryRun) {
    Warn ""
    Warn "The admin app is not in this payload, so no shortcut was made. The"
    Warn "console can still be reached by running start-all.ps1 and opening"
    Warn "http://127.0.0.1:4000 in a browser."
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

# ------------------------------------------------- 7. record what is installed

# The baseline the next update diffs against: without it, an update has nothing
# to compare the incoming payload with and has to replace all 617 MB and restart
# every service, voice included.
#
# Written last, and only on a run that got this far. A half-finished install
# that claimed a component was in place would send the next update straight past
# the one thing it needed to fix.
if (-not $DryRun) {
    $manifestSource = Join-Path $InstallDir 'payload.json'
    if (-not (Test-Path $manifestSource)) { $manifestSource = Join-Path $here 'payload.json' }
    if (Test-Path $manifestSource) {
        Copy-Item $manifestSource (Join-Path $InstallDir 'installed.json') -Force
    } else {
        Warn ""
        Warn "This payload has no payload.json, so nothing recorded what is installed."
        Warn "The next update will replace everything and restart every service,"
        Warn "including LiveKit. Rebuild the installer with the current"
        Warn "build-server-installer.ps1 to get short updates."
    }
}

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
