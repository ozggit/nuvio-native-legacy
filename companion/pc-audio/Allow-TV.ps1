# Run in an Administrator PowerShell window if Windows blocks the TV connection.
$ErrorActionPreference = 'Stop'
$name = 'Nuvio PC Audio - local network'
$nodePath = (Get-Command node).Source
if (-not (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8787 -RemoteAddress LocalSubnet -Program $nodePath -Profile Any -ErrorAction Stop | Out-Null
}
if (-not (Get-NetFirewallRule -DisplayName $name -ErrorAction Stop)) { throw 'The firewall rule was not created.' }
Write-Host 'Allowed the TV to reach port 8787 from the local network. The setup page remains PC-only.'
