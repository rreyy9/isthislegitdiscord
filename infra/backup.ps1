# Backs up the database and the uploaded files.
#
#   powershell -ExecutionPolicy Bypass -File infra\backup.ps1 -Destination D:\backups\isthislegit
#
# This is the one piece of this deployment whose absence was unrecoverable.
# Every message ten people have written, every image they have posted and every
# password hash lived in exactly one place, on a home box, with retention --
# a feature whose entire job is to delete things on purpose -- built and
# waiting. Retention stays switched off until this has run somewhere real.
#
#   -Destination <path>   where backups go. A different physical disk at the
#                         very least, and ideally not this machine at all: a
#                         copy on the same drive survives a mistake and does
#                         not survive the drive.
#   -Keep <n>             dated dumps to keep (default 14). Older ones are
#                         removed after a successful run, never before.
#   -PurgeUploads         let the upload mirror delete files the server no
#                         longer has. Off by default -- see the note below.
#   -SkipUploads          database only.
#   -NoVerify             skip reading the dump back. Do not.
#   -Install              register a nightly scheduled task and exit.
#   -Uninstall            remove that task and exit.
#   -DryRun               say what would happen, change nothing.
#
# Keep this file ASCII-only and BOM'd. Windows PowerShell 5.1 reads a BOM-less
# .ps1 as Windows-1252, which has broken a script in this repo before.

[CmdletBinding()]
param(
    [string] $Destination,
    [int]    $Keep = 14,
    [switch] $PurgeUploads,
    [switch] $SkipUploads,
    [switch] $NoVerify,
    [switch] $Install,
    [switch] $Uninstall,
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

function Say([string] $t, [string] $c = 'Cyan') { Write-Host $t -ForegroundColor $c }
function Warn([string] $t) { Write-Host $t -ForegroundColor Yellow }
function Fail([string] $t) { Write-Host $t -ForegroundColor Red; exit 1 }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# Two layouts, the same way start-all.ps1 works it out: a repo checkout has the
# server under apps/server, an installed copy has it under server/ beside this
# script. Getting this wrong points the backup at a directory that does not
# exist, which is a backup that reports success and holds nothing.
$repoRoot = (Resolve-Path (Join-Path $here '..')).Path
if (Test-Path (Join-Path $repoRoot 'apps\server\package.json')) {
    $root      = $repoRoot
    $serverDir = Join-Path $root 'apps\server'
    $dataDir   = Join-Path $root 'data'
} else {
    $root      = $here
    $serverDir = Join-Path $root 'server'
    $dataDir   = Join-Path $root 'data'
}

$envPath = Join-Path $serverDir '.env'
if (-not (Test-Path $envPath)) { Fail "No .env at $envPath -- cannot find the database." }

# ---------------------------------------------------------------- the .env

# Read explicitly as UTF-8 without a BOM, to match how it is written. Reading
# it with -Raw and the default encoding is the exact bug that mangled every em
# dash in a YAML file in this repo.
$envText = [System.IO.File]::ReadAllText($envPath, (New-Object System.Text.UTF8Encoding($false)))

function EnvValue([string] $name) {
    foreach ($line in ($envText -split "`n")) {
        # Split on newlines and match per line rather than running a multiline
        # regex over the whole file: an anchor like [ \t]*$ does not cover \r
        # and silently matches nothing on a CRLF file. That one shipped a
        # placeholder LiveKit key to production.
        $line = $line.TrimEnd("`r")
        if ($line -match "^\s*$name\s*=\s*(.*)$") {
            return $matches[1].Trim().Trim('"').Trim("'")
        }
    }
    return $null
}

$dbUrl = EnvValue 'DATABASE_URL'
if (-not $dbUrl) { Fail "DATABASE_URL is not set in $envPath." }

# postgres://user:password@host:port/database?schema=public
if ($dbUrl -notmatch '^postgres(?:ql)?://([^:]+):([^@]*)@([^:/]+):(\d+)/([^?]+)') {
    Fail "Could not parse DATABASE_URL. Expected postgres://user:pass@host:port/database."
}
$dbUser = $matches[1]
$dbPass = [System.Uri]::UnescapeDataString($matches[2])
$dbHost = $matches[3]
$dbPort = $matches[4]
$dbName = $matches[5]

$uploadDir = EnvValue 'UPLOAD_DIR'
if (-not $uploadDir) { $uploadDir = Join-Path $dataDir 'uploads' }
$uploadDir = $uploadDir -replace '/', '\'

# --------------------------------------------------------------- postgres

# The same search the installer does: the tool on PATH first, then the
# highest-numbered install under Program Files.
function Find-PgTool([string] $name) {
    $found = (Get-Command $name -ErrorAction SilentlyContinue).Source
    if ($found) { return $found }
    $candidate = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\$name.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    if ($candidate) { return $candidate.FullName }
    return $null
}

# ---------------------------------------------------------- install/remove

$taskName = 'isthislegit-backup'

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Say "Removed the scheduled task $taskName."
    } else {
        Say "No scheduled task named $taskName."
    }
    exit 0
}

if ($Install) {
    if (-not $Destination) { Fail "-Install needs -Destination, so the task knows where to write." }
    $self = $MyInvocation.MyCommand.Path
    $argLine = "-ExecutionPolicy Bypass -NoProfile -File `"$self`" -Destination `"$Destination`" -Keep $Keep"
    if ($PurgeUploads) { $argLine += ' -PurgeUploads' }
    if ($SkipUploads)  { $argLine += ' -SkipUploads' }

    # 03:30, half an hour ahead of the retention sweeper's 4am cron. The order
    # matters and is the whole point: the backup has to hold the night's data
    # before anything is allowed to start deleting it.
    $action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine
    $trigger = New-ScheduledTaskTrigger -Daily -At 3:30am
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
        -ExecutionTimeLimit (New-TimeSpan -Hours 4)

    if ($DryRun) {
        Say "Would register $taskName daily at 03:30:"
        Say "  powershell.exe $argLine"
        exit 0
    }
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Settings $settings -RunLevel Highest -Force | Out-Null
    Say "Registered $taskName, daily at 03:30 (before the 4am retention sweep)."
    Say "Run it once now to prove it works:  Start-ScheduledTask -TaskName $taskName"
    exit 0
}

# ------------------------------------------------------------------ checks

if (-not $Destination) {
    Fail "-Destination is required. Give it a path on another disk, or a UNC share."
}

$pgDump = Find-PgTool 'pg_dump'
if (-not $pgDump) { Fail "pg_dump.exe not found. Install PostgreSQL's client tools." }

# A backup on the same volume as the thing it backs up survives a mistake and
# does not survive the disk. Said out loud rather than refused, because "the
# same disk" is still better than the nothing this replaces.
try {
    $srcRoot = [System.IO.Path]::GetPathRoot((Resolve-Path $serverDir).Path)
    $dstRoot = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Destination))
    if ($srcRoot -and $dstRoot -and $srcRoot -eq $dstRoot) {
        Warn "The destination is on $dstRoot, the same volume as the server."
        Warn "That protects you from a mistake, not from the disk. Move it when you can."
    }
} catch { }

$stamp    = Get-Date -Format 'yyyy-MM-dd-HHmmss'
$runDir   = Join-Path $Destination $stamp
$dumpPath = Join-Path $runDir 'database.dump'

Say "isthislegit backup"
Say "  database    $dbName on ${dbHost}:${dbPort} as $dbUser"
Say "  uploads     $uploadDir"
Say "  destination $runDir"
if ($DryRun) { Say "  (dry run -- nothing will be written)" }

# --------------------------------------------------------------- the dump

if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path $runDir | Out-Null
}

Say ""
Say "Dumping the database..."
if ($DryRun) {
    Say "  would run: $pgDump -h $dbHost -p $dbPort -U $dbUser -d $dbName -Fc -f $dumpPath"
} else {
    # PGPASSWORD rather than the password on the command line: a command line is
    # readable by every other process on the box.
    $previous = $env:PGPASSWORD
    $env:PGPASSWORD = $dbPass
    try {
        # -Fc is the custom format: compressed, and restorable table by table,
        # which is what makes "restore only the messages" possible later. Plain
        # SQL is readable but cannot do that, and is several times larger.
        & $pgDump -h $dbHost -p $dbPort -U $dbUser -d $dbName -Fc -f $dumpPath
        if ($LASTEXITCODE -ne 0) { throw "pg_dump exited $LASTEXITCODE" }
    } catch {
        Warn "  the dump failed: $($_.Exception.Message)"
        # A half-written dump is worse than no dump, because it looks like one.
        if (Test-Path $dumpPath) { Remove-Item $dumpPath -Force }
        # And an empty dated directory reads, in a listing, as a night that was
        # backed up. Take it with the dump.
        if ((Get-ChildItem $runDir -Force | Measure-Object).Count -eq 0) {
            Remove-Item $runDir -Force
        }
        Fail "Backup aborted. Nothing was deleted."
    } finally {
        $env:PGPASSWORD = $previous
    }

    $mb = [math]::Round((Get-Item $dumpPath).Length / 1MB, 1)
    Say "  wrote database.dump ($mb MB)"
}

# ---------------------------------------------------------------- verify

# The step that separates a backup from a file. An unreadable dump fails at
# exactly the moment there is nothing else left, so it is read back now, while
# somebody is watching and the original still exists.
if (-not $NoVerify -and -not $DryRun) {
    $pgRestore = Find-PgTool 'pg_restore'
    if (-not $pgRestore) {
        Warn "  pg_restore not found -- the dump was NOT verified."
    } else {
        Say "Verifying..."
        $listing = & $pgRestore --list $dumpPath 2>&1
        if ($LASTEXITCODE -ne 0) {
            Remove-Item $dumpPath -Force
            Fail "The dump is not readable by pg_restore. It has been deleted rather than kept as a false comfort."
        }
        # A dump of an empty or unrelated database also lists cleanly, so
        # check this application's tables are actually in it. That is what
        # catches a backup pointed at the wrong database -- chat_dev instead
        # of chat, which this repo now makes possible on purpose.
        #
        # Joined into one string first: -match and -notmatch against an array
        # do not return a boolean, they return the matching elements, and an
        # empty array is falsy while any non-empty one is truthy. Used in an
        # if, that reads as the opposite of the question being asked. This
        # check reported every table missing until it was written this way.
        $listingText = ($listing | Out-String)
        $expected = @('user', 'Guild', 'GuildMember', 'Channel', 'Message', 'Attachment')
        $missing = @()
        foreach ($t in $expected) {
            if ($listingText -notmatch "TABLE DATA public $t\s") { $missing += $t }
        }
        if ($missing.Count -gt 0) {
            Warn "  readable, but these tables are not in the dump: $($missing -join ', ')"
            Warn "  The backup is pointed at a database that is not this application's."
        } else {
            Say "  readable, and every expected table is in it"
        }
        # Deliberately not a row count. pg_dump lists a TABLE DATA entry for
        # every table whether or not it holds rows, so the listing cannot tell
        # a full database from an empty one. Only a restore can, which is what
        # restore.ps1 -Into exists to make cheap enough to actually do.
    }
}

# --------------------------------------------------------------- uploads

# Files, not rows, and nearly all of the bytes. Copied rather than dumped
# because they are already files and never change once written.
#
# Additive by default: the retention sweeper deletes uploads on purpose, and a
# true mirror would faithfully delete them from the backup too -- which turns
# the safety net into a second copy of the same policy. -PurgeUploads is there
# for when the backup disk fills and that trade becomes worth making.
if (-not $SkipUploads) {
    Say ""
    if (-not (Test-Path $uploadDir)) {
        Warn "No upload directory at $uploadDir -- skipping files."
    } else {
        $uploadDest = Join-Path $Destination 'uploads'
        Say "Copying uploads to $uploadDest..."
        if ($DryRun) {
            Say "  would robocopy $uploadDir -> $uploadDest"
        } else {
            $flags = @('/E', '/R:2', '/W:2', '/NFL', '/NDL', '/NJH', '/NP')
            if ($PurgeUploads) { $flags += '/PURGE' }
            & robocopy $uploadDir $uploadDest @flags | Out-Null
            # Robocopy's exit code is a bit field, not a status. Under 8 is
            # success of some kind (0 nothing to do, 1 copied, 2 extras, 3
            # both); 8 and up are real failures. Treating it like any other
            # exit code reports every working night as a failure, until
            # somebody stops reading the output altogether.
            if ($LASTEXITCODE -ge 8) { Fail "robocopy failed with $LASTEXITCODE" }
            $global:LASTEXITCODE = 0
            $count = (Get-ChildItem $uploadDest -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
            Say "  $count file(s) in the upload backup"
        }
    }
}

# ------------------------------------------------------------- old dumps

# Only after everything above succeeded. Deleting yesterday's good backup
# before today's is proven is how one bad night costs two.
if (-not $DryRun -and $Keep -gt 0) {
    $runs = @(Get-ChildItem $Destination -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}-\d{6}$' } |
        Sort-Object Name -Descending)
    if ($runs.Count -gt $Keep) {
        Say ""
        Say "Removing $($runs.Count - $Keep) dump(s) older than the newest $Keep..."
        foreach ($old in $runs[$Keep..($runs.Count - 1)]) {
            Remove-Item $old.FullName -Recurse -Force
            Say "  removed $($old.Name)"
        }
    }
}

Say ""
Say "Done." 'Green'
if (-not $DryRun) {
    Say "Restore with:  infra\restore.ps1 -From `"$runDir`"" 'Green'
}
