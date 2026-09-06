# Starts everything this deployment needs, in one command.
#
#   powershell -ExecutionPolicy Bypass -File infra\start-all.ps1
#
# Each service gets its own window, because each has logs worth reading and a
# crash in one should be visible rather than buried in a shared stream. This
# script only launches them; it does not stay in the way afterwards.
#
#   -Stop      stop all three again
#   -Status    say what is running, change nothing
#   -NoCaddy   skip the TLS proxy, for working on the LAN
#
# PostgreSQL is deliberately not started here: it is a Windows service and
# starts on boot already.
#
# Keep this file ASCII-only and BOM'd. Windows PowerShell 5.1 reads a BOM-less
# .ps1 as Windows-1252, which has broken a script in this repo before.

[CmdletBinding()]
param(
    [switch] $Stop,
    [switch] $Status,
    [switch] $NoCaddy
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = (Resolve-Path (Join-Path $here '..')).Path

function Say([string] $t, [string] $c = 'Cyan') { Write-Host $t -ForegroundColor $c }
function Warn([string] $t) { Write-Host $t -ForegroundColor Yellow }

# Everything is identified by the port it listens on, never by image name.
# Three of these are node.exe, and so is anything else the machine happens to
# be running -- matching on the name is how you kill PostgreSQL by accident.
$services = @(
    @{ Name = 'chat server'; Port = 3000; Task = 'isthislegit-server' }
    @{ Name = 'livekit';     Port = 7880; Task = 'isthislegit-livekit' }
    @{ Name = 'caddy';       Port = 443;  Task = 'isthislegit-caddy' }
)
if ($NoCaddy) { $services = $services | Where-Object { $_.Name -ne 'caddy' } }

function Get-Listener([int] $port) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
}

function Show-Status {
    Write-Host ""
    foreach ($s in $services) {
        $listener = Get-Listener $s.Port
        if ($listener) {
            $proc = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
            $who = if ($proc) { "$($proc.ProcessName) pid $($proc.Id)" } else { "pid $($listener.OwningProcess)" }
            Write-Host ("  {0,-12} up    :{1,-5}  {2}" -f $s.Name, $s.Port, $who) -ForegroundColor Green
        } else {
            Write-Host ("  {0,-12} down  :{1}" -f $s.Name, $s.Port) -ForegroundColor DarkGray
        }
    }
    Write-Host ""
}

# ------------------------------------------------------------------- status

if ($Status) {
    $pg = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pg) {
        $colour = if ($pg.Status -eq 'Running') { 'Green' } else { 'Red' }
        Write-Host ""
        Write-Host ("  {0,-12} {1}" -f 'postgres', $pg.Status.ToString().ToLower()) -ForegroundColor $colour
    }
    Show-Status
    return
}

# --------------------------------------------------------------------- stop

if ($Stop) {
    foreach ($s in $services) {
        $listener = Get-Listener $s.Port
        if (-not $listener) {
            Write-Host ("  {0,-12} already stopped" -f $s.Name) -ForegroundColor DarkGray
            continue
        }
        # Stop whatever holds the port, so this also clears instances started
        # by hand or left behind by a previous run.
        Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
        Write-Host ("  {0,-12} stopped (pid {1})" -f $s.Name, $listener.OwningProcess) -ForegroundColor Yellow
    }
    Write-Host ""
    Warn "PostgreSQL was left running -- it is a service, and stopping it is a"
    Warn "separate decision. The operator console can do it if you need to."
    return
}

# -------------------------------------------------------------------- start

# Nothing works without the database, and its absence otherwise surfaces as a
# migration or connection error several steps later.
$pg = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $pg) {
    Warn "No PostgreSQL service found. Install PostgreSQL 17 first -- nothing here"
    Warn "will start without it."
    exit 1
}
if ($pg.Status -ne 'Running') {
    Say "Starting PostgreSQL ($($pg.Name))"
    try {
        Start-Service $pg.Name
    } catch {
        Warn "  could not start it -- that needs an elevated terminal."
        Warn "  Start it yourself, or re-run this elevated."
        exit 1
    }
}

$serverDir = Join-Path $repo 'apps\server'
if (-not (Test-Path (Join-Path $serverDir 'dist\main.js'))) {
    Warn "apps\server\dist\main.js does not exist -- the server is not built."
    Warn "Build it first:  npm run build"
    exit 1
}

# Each service is launched as its own visible PowerShell window, titled, and
# left open when the process exits so a startup error can still be read.
function Start-InWindow([string] $title, [string] $workingDir, [string] $command) {
    $inner = "`$Host.UI.RawUI.WindowTitle = '$title'; $command"
    Start-Process -FilePath 'powershell' -WorkingDirectory $workingDir -ArgumentList @(
        '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $inner
    ) | Out-Null
}

foreach ($s in $services) {
    if (Get-Listener $s.Port) {
        Write-Host ("  {0,-12} already up on :{1}" -f $s.Name, $s.Port) -ForegroundColor DarkGray
        continue
    }

    switch ($s.Name) {
        'chat server' {
            Say "Starting chat server"
            Start-InWindow 'isthislegit server' $serverDir 'node dist\main.js'
        }
        'livekit' {
            Say "Starting livekit"
            Start-InWindow 'isthislegit livekit' (Join-Path $repo 'infra\livekit') `
                "& '$repo\infra\livekit\start.ps1'"
        }
        'caddy' {
            Say "Starting caddy"
            Start-InWindow 'isthislegit caddy' (Join-Path $repo 'infra\caddy') `
                "& '$repo\infra\caddy\start.ps1'"
        }
    }

    # Give each one a moment to bind before the next is started and before the
    # status below is read. Caddy in particular warns about backends that are
    # not up yet, and the warning is noise if they simply have not started.
    Start-Sleep -Seconds 2
}

# Certificates on a first run take longer than the loop above waits, so a
# 'down' for caddy here is not necessarily a failure -- its own window says.
Start-Sleep -Seconds 2
Show-Status

Say "The operator console is separate, and optional:" 'DarkGray'
Say "  npm run console   ->  http://127.0.0.1:4000" 'DarkGray'
Write-Host ""
Say "Stop everything again with:  -Stop      Check without changing:  -Status" 'DarkGray'
