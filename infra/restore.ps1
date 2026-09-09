# Restores a backup made by infra\backup.ps1.
#
#   powershell -ExecutionPolicy Bypass -File infra\restore.ps1 -From D:\backups\isthislegit\2026-09-08-033000
#
# A backup nobody has restored is a guess. Run this at least once, into a
# throwaway database, before believing the thing that made it:
#
#   infra\restore.ps1 -From <a backup> -Into chat_restore_test
#
# which creates that database, restores into it, prints the row counts and
# leaves the live one alone. That is the drill, and it is the whole reason
# -Into exists.
#
#   -From <path>     a dated backup directory, or a .dump file directly.
#   -Into <name>     database to restore into. Defaults to the one named in
#                    .env, which is the live one -- so this is deliberately
#                    the parameter you have to type.
#   -Force           allow restoring over the live database. Required, and
#                    refused while the server is running.
#   -SkipUploads     database only; leave the files where they are.
#   -DryRun          say what would happen, change nothing.
#
# Keep this file ASCII-only and BOM'd. Windows PowerShell 5.1 reads a BOM-less
# .ps1 as Windows-1252, which has broken a script in this repo before.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $From,
    [string] $Into,
    [switch] $Force,
    [switch] $SkipUploads,
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

function Say([string] $t, [string] $c = 'Cyan') { Write-Host $t -ForegroundColor $c }
function Warn([string] $t) { Write-Host $t -ForegroundColor Yellow }
function Fail([string] $t) { Write-Host $t -ForegroundColor Red; exit 1 }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

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

$envText = [System.IO.File]::ReadAllText($envPath, (New-Object System.Text.UTF8Encoding($false)))

function EnvValue([string] $name) {
    foreach ($line in ($envText -split "`n")) {
        $line = $line.TrimEnd("`r")
        if ($line -match "^\s*$name\s*=\s*(.*)$") {
            return $matches[1].Trim().Trim('"').Trim("'")
        }
    }
    return $null
}

$dbUrl = EnvValue 'DATABASE_URL'
if (-not $dbUrl) { Fail "DATABASE_URL is not set in $envPath." }
if ($dbUrl -notmatch '^postgres(?:ql)?://([^:]+):([^@]*)@([^:/]+):(\d+)/([^?]+)') {
    Fail "Could not parse DATABASE_URL. Expected postgres://user:pass@host:port/database."
}
$dbUser = $matches[1]
$dbPass = [System.Uri]::UnescapeDataString($matches[2])
$dbHost = $matches[3]
$dbPort = $matches[4]
$liveDb = $matches[5]

$targetDb = if ($Into) { $Into } else { $liveDb }

$uploadDir = EnvValue 'UPLOAD_DIR'
if (-not $uploadDir) { $uploadDir = Join-Path $dataDir 'uploads' }
$uploadDir = $uploadDir -replace '/', '\'

function Find-PgTool([string] $name) {
    $found = (Get-Command $name -ErrorAction SilentlyContinue).Source
    if ($found) { return $found }
    $candidate = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\$name.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    if ($candidate) { return $candidate.FullName }
    return $null
}

$pgRestore = Find-PgTool 'pg_restore'
$psql      = Find-PgTool 'psql'
if (-not $pgRestore) { Fail "pg_restore.exe not found. Install PostgreSQL's client tools." }
if (-not $psql)      { Fail "psql.exe not found. Install PostgreSQL's client tools." }

# ----------------------------------------------------------- what to restore

if (-not (Test-Path $From)) { Fail "Nothing at $From." }

if ((Get-Item $From).PSIsContainer) {
    $dumpPath  = Join-Path $From 'database.dump'
    $backupDir = $From
} else {
    $dumpPath  = $From
    $backupDir = Split-Path -Parent $From
}
if (-not (Test-Path $dumpPath)) { Fail "No database.dump in $From." }

# ------------------------------------------------------------------ safety

# Restoring over the live database is the destructive case, so it takes two
# deliberate acts: naming it and passing -Force. Everything else defaults to
# the safe shape.
$overwritingLive = ($targetDb -eq $liveDb)
if ($overwritingLive -and -not $Force) {
    Warn "$targetDb is the live database named in .env."
    Warn ""
    Warn "Restoring over it replaces everything currently in it. If you are"
    Warn "testing that this backup works -- which is the point of doing this"
    Warn "before you need it -- restore somewhere else instead:"
    Warn ""
    Warn "  infra\restore.ps1 -From `"$From`" -Into chat_restore_test"
    Warn ""
    Fail "Refusing without -Force."
}

# A restore into a database the server is reading and writing produces neither
# the old data nor the new. Checked rather than assumed, because the failure is
# quiet and lands on people who are mid-conversation.
if ($overwritingLive) {
    $listening = $null
    try {
        $listening = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
    } catch { }
    if ($listening) {
        Fail "The chat server is still listening on :3000. Stop it first (infra\start-all.ps1 -Stop)."
    }
}

Say "isthislegit restore"
Say "  from        $dumpPath"
Say "  into        $targetDb on ${dbHost}:${dbPort} as $dbUser"
if (-not $overwritingLive) { Say "  (the live database, $liveDb, is not being touched)" 'Green' }
if ($DryRun) { Say "  (dry run -- nothing will be written)" }
Say ""

$previous = $env:PGPASSWORD
$env:PGPASSWORD = $dbPass
try {
    # ------------------------------------------------------- the database

    # Created if missing, so restoring into a scratch name is one command and
    # not a setup ritual with three steps to get wrong.
    $exists = & $psql -h $dbHost -p $dbPort -U $dbUser -d postgres -tAc `
        "SELECT 1 FROM pg_database WHERE datname = '$targetDb'"
    if ($LASTEXITCODE -ne 0) { throw "could not reach PostgreSQL as $dbUser" }

    if (-not $exists) {
        Say "Creating $targetDb..."
        if (-not $DryRun) {
            & $psql -h $dbHost -p $dbPort -U $dbUser -d postgres -c "CREATE DATABASE `"$targetDb`"" 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                # The application role deliberately has no CREATEDB -- it never
                # needs it, and these scripts are the only things that ever do.
                # So fall back to the superuser, which prompts for its own
                # password rather than this script handling one. A test restore
                # is something a person runs at a terminal, so a prompt is fine;
                # what is not fine is the drill being blocked at the one step
                # that makes it worth doing at all.
                Warn "  $dbUser cannot create databases. Falling back to the postgres superuser."
                Warn "  You will be asked for its password."
                $env:PGPASSWORD = $null
                & $psql -h $dbHost -p $dbPort -U postgres -d postgres `
                    -c "CREATE DATABASE `"$targetDb`" OWNER $dbUser"
                $createdOk = ($LASTEXITCODE -eq 0)
                $env:PGPASSWORD = $dbPass
                if (-not $createdOk) {
                    throw "could not create $targetDb, as $dbUser or as postgres"
                }
            }
        }
    }

    Say "Restoring..."
    if ($DryRun) {
        Say "  would run: $pgRestore -d $targetDb --clean --if-exists --no-owner $dumpPath"
    } else {
        # --clean --if-exists drops what is there first, so this is a replace
        # and not a merge onto whatever the database already held. --no-owner
        # because the dump records chat_app as the owner and the role may not
        # exist under that name on a machine doing a test restore.
        #
        # Not --single-transaction: a --clean restore emits drops for objects
        # that may legitimately be absent, and one of those inside a
        # transaction rolls the whole thing back. Errors are counted below
        # instead.
        & $pgRestore -h $dbHost -p $dbPort -U $dbUser -d $targetDb `
            --clean --if-exists --no-owner --no-privileges $dumpPath 2>&1 |
            Tee-Object -Variable restoreOut | Out-Null

        $errors = @($restoreOut | Where-Object { $_ -match '^pg_restore: error:' })
        if ($errors.Count -gt 0) {
            Warn "  pg_restore reported $($errors.Count) error(s):"
            $errors | Select-Object -First 10 | ForEach-Object { Warn "    $_" }
            Fail "Restore did not complete cleanly. The database is in an unknown state."
        }
        Say "  restored"
    }

    # ------------------------------------------------------- prove it took

    # Row counts, printed. A restore that "succeeded" into an empty database is
    # the failure this whole exercise is meant to catch, and it is invisible
    # unless something looks.
    if (-not $DryRun) {
        Say ""
        Say "What is in $targetDb now:"
        foreach ($t in @('user', 'guild', 'channel', 'message', 'attachment')) {
            $n = & $psql -h $dbHost -p $dbPort -U $dbUser -d $targetDb -tAc `
                "SELECT count(*) FROM `"$t`""
            if ($LASTEXITCODE -eq 0) {
                Say ("  {0,-12} {1}" -f $t, $n.Trim())
            } else {
                Warn ("  {0,-12} could not be read" -f $t)
            }
        }
    }
} catch {
    Fail "Restore failed: $($_.Exception.Message)"
} finally {
    $env:PGPASSWORD = $previous
}

# ---------------------------------------------------------------- uploads

# Only when restoring over the live database. Copying a backup's files into the
# live upload directory during a test restore would put images back that
# retention deleted on purpose, which is a surprise nobody asked for.
if (-not $SkipUploads) {
    $uploadBackup = Join-Path $backupDir '..\uploads'
    if (Test-Path $uploadBackup) {
        $uploadBackup = (Resolve-Path $uploadBackup).Path
        Say ""
        if (-not $overwritingLive) {
            Say "Upload files are at $uploadBackup."
            Say "Not copied: this is a test restore, and $uploadDir belongs to the live server."
        } elseif ($DryRun) {
            Say "Would copy $uploadBackup -> $uploadDir"
        } else {
            Say "Restoring uploads to $uploadDir..."
            & robocopy $uploadBackup $uploadDir /E /R:2 /W:2 /NFL /NDL /NJH /NP | Out-Null
            if ($LASTEXITCODE -ge 8) { Fail "robocopy failed with $LASTEXITCODE" }
            $global:LASTEXITCODE = 0
            $count = (Get-ChildItem $uploadDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
            Say "  $count file(s) in $uploadDir"
        }
    }
}

Say ""
Say "Done." 'Green'
if (-not $overwritingLive -and -not $DryRun) {
    Say "Drop the test database when you are satisfied:" 'Green'
    Say "  psql -U $dbUser -d postgres -c 'DROP DATABASE `"$targetDb`"'" 'Green'
}
