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

# LocalOnly rules stay scoped to LocalSubnet even under -Internet. Caddy
# terminates TLS on 443 and reaches the chat server and LiveKit's signalling
# over loopback, so neither has any reason to be reachable from outside -- and
# both would be reachable in plaintext if they were. They stay open on the LAN
# because that is still the quickest way to test from another machine here.
#
# The media ports are not LocalOnly and cannot be: WebRTC media goes straight
# to this box rather than through Caddy. It is already DTLS-SRTP encrypted, so
# there is nothing to terminate and nothing gained by proxying it.
$rules = @(
    @{ Name = 'caddy tls';         Protocol = 'TCP'; Port = '443' }
    @{ Name = 'chat server';       Protocol = 'TCP'; Port = '3000'; LocalOnly = $true }
    @{ Name = 'livekit signal';    Protocol = 'TCP'; Port = '7880'; LocalOnly = $true }
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

    # A LocalOnly rule never widens, whatever mode the script was run in.
    $ruleScope = if ($r.LocalOnly) { 'LocalSubnet' } else { $scope }
    $ruleLabel = if ($r.LocalOnly) { 'local subnet only' } else { $scopeLabel }

    New-NetFirewallRule -DisplayName $display `
        -Direction Inbound -Action Allow `
        -Protocol $r.Protocol -LocalPort $r.Port `
        -RemoteAddress $ruleScope -Profile Any | Out-Null

    Write-Host "allowed  $display  ($ruleLabel)" -ForegroundColor Green
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
Write-Host "Three things this script cannot do for you, and nothing works without all:"
Write-Host "  1. Forward 443, 7881 (TCP), 3478 and 50000-50100 (UDP) on the router"
Write-Host "     to 192.168.1.230. Same numbers on both sides - LiveKit advertises"
Write-Host "     the port it believes it is on, so translating them breaks voice"
Write-Host "     and nothing else. Do NOT forward 3000 or 7880 any more: Caddy"
Write-Host "     reaches both over loopback, and forwarding them would publish the"
Write-Host "     same two services again without TLS in front."
Write-Host "  2. Run Caddy - infra\caddy\start.ps1. Without it 443 answers nothing."
Write-Host "  3. Check LIVEKIT_URL in apps/server/.env reads"
Write-Host "     wss://isthislegit-lk.duckdns.org and livekit.yaml has"
Write-Host "     use_external_ip: true."
Write-Host ""
Write-Host "People outside then connect to:" -ForegroundColor Cyan
Write-Host "  chat   https://isthislegit.duckdns.org"
Write-Host "  voice  wss://isthislegit-lk.duckdns.org"
Write-Host ""
Write-Host "Both names are DuckDNS records that follow this connection's public"
Write-Host "address ($public today), so an ISP lease change no longer breaks them."
Write-Host "LiveKit is the exception: it discovers the public address by STUN once"
Write-Host "at startup and advertises it in ICE candidates, so after the address"
Write-Host "moves, voice stays silent until LiveKit is restarted. Chat recovers on"
Write-Host "its own; voice needs the restart."
