# System tray control for the isthislegit services.
#
# Do not run this directly -- it would sit behind a console window. Double
# click isthislegit-tray.vbs next to it, which launches this hidden.
#
# What it is for: seeing at a glance whether the three services are up, and
# starting or stopping them without a terminal. It is not a supervisor. On the
# server machine the installer registers scheduled tasks that start everything
# at boot and restart it on failure, and that remains the thing keeping the
# server up -- this is a window onto it, not a replacement for it.
#
# Keep this file ASCII-only and BOM'd. Windows PowerShell 5.1 reads a BOM-less
# .ps1 as Windows-1252, which has broken a script in this repo before.

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = (Resolve-Path (Join-Path $here '..\..')).Path
$startAll = Join-Path $repo 'infra\start-all.ps1'

# Matched by listening port, never by image name. Three of these are node.exe
# and so is anything else on the machine; matching on the name is how
# PostgreSQL gets killed by accident.
$services = @(
    @{ Name = 'Chat server'; Port = 3000 }
    @{ Name = 'LiveKit';     Port = 7880 }
    @{ Name = 'Caddy (TLS)'; Port = 443 }
)

# ------------------------------------------------------------------- icons

# Drawn at runtime rather than shipped as .ico files: three flat discs is not
# worth three binaries in the repo, and this way the colours stay next to the
# thresholds that choose them. Created once and reused -- an icon built per
# poll would leak a GDI handle every few seconds.
function New-DiscIcon([System.Drawing.Color] $colour) {
    $bmp = New-Object System.Drawing.Bitmap 16, 16
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $brush = New-Object System.Drawing.SolidBrush $colour
    $g.FillEllipse($brush, 1, 1, 14, 14)
    $brush.Dispose()
    $g.Dispose()
    $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    $bmp.Dispose()
    return $icon
}

$iconUp      = New-DiscIcon ([System.Drawing.Color]::FromArgb(64, 192, 87))
$iconPartial = New-DiscIcon ([System.Drawing.Color]::FromArgb(250, 176, 5))
$iconDown    = New-DiscIcon ([System.Drawing.Color]::FromArgb(140, 140, 140))

# ------------------------------------------------------------------ helpers

function Test-Port([int] $port) {
    [bool] (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Invoke-StartAll([string[]] $extraArgs) {
    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $startAll) + $extraArgs
    Start-Process -FilePath 'powershell' -ArgumentList $args -WindowStyle Hidden | Out-Null
}

# --------------------------------------------------------------------- menu

$menu = New-Object System.Windows.Forms.ContextMenuStrip

# The first entries are one per service and are only ever labels -- clicking a
# status line and having it do something unstated is worse than it doing
# nothing.
$statusItems = @{}
foreach ($s in $services) {
    $item = New-Object System.Windows.Forms.ToolStripMenuItem
    $item.Enabled = $false
    $menu.Items.Add($item) | Out-Null
    $statusItems[$s.Name] = $item
}

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$startItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Start all'
$startItem.Add_Click({ Invoke-StartAll @() })
$menu.Items.Add($startItem) | Out-Null

$stopItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Stop all'
$stopItem.Add_Click({ Invoke-StartAll @('-Stop') })
$menu.Items.Add($stopItem) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$consoleItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Open operator console'
$consoleItem.Add_Click({
    # The console is a separate process and is not started by start-all: it is
    # the admin UI, not part of the server. Start it if nothing holds 4000.
    if (-not (Test-Port 4000)) {
        Start-Process -FilePath 'powershell' -WorkingDirectory $repo -WindowStyle Hidden -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'npm run console'
        ) | Out-Null
        Start-Sleep -Seconds 2
    }
    Start-Process 'http://127.0.0.1:4000'
})
$menu.Items.Add($consoleItem) | Out-Null

$folderItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Open folder'
$folderItem.Add_Click({ Start-Process explorer.exe $repo })
$menu.Items.Add($folderItem) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Exit'
$menu.Items.Add($exitItem) | Out-Null

# ---------------------------------------------------------------- the icon

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $iconDown
$tray.Text = 'isthislegit'
$tray.ContextMenuStrip = $menu
$tray.Visible = $true

# Left click should also show the menu. NotifyIcon only does that for right
# click on its own, and a tray icon that ignores a left click feels broken.
$tray.Add_MouseUp({
    if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        $method = $tray.ContextMenuStrip.GetType().GetMethod(
            'ShowDropDown', [Reflection.BindingFlags]'Instance,NonPublic')
        if ($method) { $method.Invoke($tray.ContextMenuStrip, @()) }
        else { $tray.ContextMenuStrip.Show([System.Windows.Forms.Cursor]::Position) }
    }
})

# --------------------------------------------------------------------- poll

$script:lastUp = -1

function Update-Status {
    $up = 0
    foreach ($s in $services) {
        $running = Test-Port $s.Port
        if ($running) { $up++ }
        $mark = if ($running) { 'up  ' } else { 'down' }
        $statusItems[$s.Name].Text = "{0,-12} {1}  :{2}" -f $s.Name, $mark, $s.Port
    }

    $total = $services.Count
    if ($up -eq $total)  { $tray.Icon = $iconUp }
    elseif ($up -eq 0)   { $tray.Icon = $iconDown }
    else                 { $tray.Icon = $iconPartial }

    # Tooltip is capped at 63 characters by the shell; anything longer is
    # silently dropped and the icon ends up with no tooltip at all.
    $tray.Text = "isthislegit - $up of $total running"

    $startItem.Enabled = $up -lt $total
    $stopItem.Enabled  = $up -gt 0

    # Only say something when the picture actually changes. A balloon every
    # poll would be intolerable, and one that never appears is no use when a
    # service dies while nobody is looking.
    if ($script:lastUp -ne -1 -and $up -ne $script:lastUp) {
        if ($up -lt $script:lastUp -and $up -lt $total) {
            $tray.BalloonTipTitle = 'isthislegit'
            $tray.BalloonTipText = "A service stopped -- $up of $total running."
            $tray.BalloonTipIcon = 'Warning'
            $tray.ShowBalloonTip(5000)
        }
    }
    $script:lastUp = $up
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({ Update-Status })
$timer.Start()

Update-Status

# ---------------------------------------------------------------- lifetime

$context = New-Object System.Windows.Forms.ApplicationContext
$exitItem.Add_Click({
    # Hide before exiting. A NotifyIcon that is not disposed leaves a dead icon
    # in the tray until the user happens to mouse over it.
    $tray.Visible = $false
    $tray.Dispose()
    $timer.Stop()
    $context.ExitThread()
})

[System.Windows.Forms.Application]::Run($context)
