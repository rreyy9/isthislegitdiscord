# Opens the ports another machine needs to reach this one, and nothing wider.
#
# Run once, elevated:
#   powershell -ExecutionPolicy Bypass -File infra\allow-lan.ps1
# Undo with:
#   powershell -ExecutionPolicy Bypass -File infra\allow-lan.ps1 -Remove
#
# By default every rule is scoped to -RemoteAddress LocalSubnet, so these ports
# stay shut to anything outside your own network even though this machine's
# connection is categorised Public.
#
# -Internet widens that scope to Any, for friends connecting from outside the
# house:
#
#   powershell -ExecutionPolicy Bypass -File infra\allow-lan.ps1 -Internet
#
# That is only ever half the job. The same ports also have to be forwarded on
# the router, and infra/livekit/livekit.yaml has to be in its internet mode
# (use_external_ip: true) or voice connects and stays silent.
#
# The rule names do not change between the two modes, so re-running in either
# mode replaces the other rather than stacking both, and -Remove clears them
# whichever mode created them.
#
# Note what is deliberately absent from the list below: the operator console
# (:4000) and PostgreSQL (:5432). The console spawns processes, so opening it
# to anything at all is remote code execution. Neither belongs here.

param([switch]$Remove, [switch]$Internet)

$ErrorActionPreference = 'Stop'
$prefix = 'isthislegit'

$rules = @(
    @{ Name = 'chat server';       Protocol = 'TCP'; Port = '3000' }
    @{ Name = 'livekit signal';    Protocol = 'TCP'; Port = '7880' }
    @{ Name = 'livekit webrtc';    Protocol = 'TCP'; Port = '7881' }
    @{ Name = 'livekit turn';      Protocol = 'UDP'; Port = '3478' }
    @{ Name = 'livekit media';     Protocol = 'UDP'; Port = '50000-50100' }
)

# Adding a firewall rule needs elevation, and the error without it does not say
# so plainly.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "This needs an elevated terminal (Run as administrator)." -ForegroundColor Red
    exit 1
}

# LocalSubnet keeps these ports shut to everything but your own network; Any is
# the deliberate widening for connections from outside it.
$scope = if ($Internet) { 'Any' } else { 'LocalSubnet' }
$scopeLabel = if ($Internet) { 'the internet' } else { 'local subnet only' }

foreach ($r in $rules) {
    $display = "$prefix $($r.Name) ($($r.Protocol) $($r.Port))"

    # Always clear first, so re-running does not stack duplicates.
    Get-NetFirewallRule -DisplayName $display -ErrorAction SilentlyContinue |
        Remove-NetFirewallRule

    if ($Remove) {
        Write-Host "removed  $display" -ForegroundColor DarkGray
        continue
    }

    New-NetFirewallRule -DisplayName $display `
        -Direction Inbound -Action Allow `
        -Protocol $r.Protocol -LocalPort $r.Port `
        -RemoteAddress $scope -Profile Any | Out-Null

    Write-Host "allowed  $display  ($scopeLabel)" -ForegroundColor Green
}

if ($Remove) { return }

Write-Host ""

if (-not $Internet) {
    Write-Host "Other machines on your network can now reach:" -ForegroundColor Cyan
    Write-Host "  chat   http://192.168.1.230:3000"
    Write-Host "  voice  ws://192.168.1.230:7880"
    Write-Host ""
    Write-Host "Check the address is still right with ipconfig - a DHCP lease can move it."
    return
}

# Ask the router's side of the connection, not this machine's: behind NAT the
# only address that means anything to someone outside is the one the ISP gave
# the router, and no local interface knows it.
try {
    $public = (Invoke-RestMethod -Uri 'https://api.ipify.org?format=json' -TimeoutSec 10).ip
} catch {
    $public = '<your-public-ip>'
}

Write-Host "The firewall is now open to the internet on those ports." -ForegroundColor Yellow
Write-Host ""
Write-Host "Two things this script cannot do for you, and nothing works without both:"
Write-Host "  1. Forward those same ports on the router to 192.168.1.230. Same"
Write-Host "     numbers on both sides - LiveKit advertises the port it believes"
Write-Host "     it is on, so translating them breaks voice and nothing else."
Write-Host "  2. Check LIVEKIT_URL in apps/server/.env reads ws://$($public):7880"
Write-Host "     and livekit.yaml has use_external_ip: true."
Write-Host ""
Write-Host "People outside then connect to:" -ForegroundColor Cyan
Write-Host "  chat   http://$($public):3000"
Write-Host "  voice  ws://$($public):7880"
Write-Host ""
Write-Host "That public address is a lease from your ISP and will move eventually."
Write-Host "When it does, chat and voice both stop for everyone outside until"
Write-Host "LIVEKIT_URL is updated - so check it before debugging anything else."
Write-Host ""
Write-Host "None of this is encrypted: plain HTTP and ws, no TLS. Anyone who finds" -ForegroundColor DarkYellow
Write-Host "port 3000 can reach the login and register endpoints, and registration" -ForegroundColor DarkYellow
Write-Host "is only as closed as your invite codes. Run -Remove when you are done." -ForegroundColor DarkYellow
