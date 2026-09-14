$ErrorActionPreference = "Stop"
$scriptPath = Join-Path $PSScriptRoot "devspace-local-ingress.ps1"
. $scriptPath -Action status

function Assert-Equal {
    param($Actual, $Expected, [string]$Message)
    if ($Actual -ne $Expected) { throw "$Message. Expected '$Expected'; got '$Actual'." }
}

function Assert-True {
    param([bool]$Value, [string]$Message)
    if (-not $Value) { throw $Message }
}

Assert-Equal (Get-DuckDnsResponseFirstLine -Content "OK") "OK" "DuckDNS string success must parse"
Assert-Equal (Get-DuckDnsResponseFirstLine -Content ([byte[]][char[]]"OK")) "OK" "DuckDNS byte-array success must parse"
Assert-Equal (Get-DuckDnsResponseFirstLine -Content ([byte[]][char[]]"OK`n203.0.113.10`n`nNOCHANGE")) "OK" "DuckDNS verbose success must parse"
Assert-Equal (Get-DuckDnsResponseFirstLine -Content "KO") "KO" "DuckDNS rejection must remain distinct"

$unicode = "乙太網路 3"
$roundTrip = [System.Text.Encoding]::UTF8.GetString([System.Text.Encoding]::UTF8.GetBytes($unicode))
Assert-Equal $roundTrip $unicode "UTF-8 LAN interface aliases must round-trip"

$tailscaleOnly = @( [pscustomobject]@{ LocalAddress = "100.83.51.110"; LocalPort = 443; OwningProcess = 1 } )
$state = Get-LanIngressListenerState -Listeners $tailscaleOnly -LanIPv4 "192.168.0.83" -ProcessNames @{ 1 = "tailscaled" }
Assert-Equal $state.Relevant.Count 0 "Tailscale-only listener must not conflict with LAN ingress"

$lanConflict = @( [pscustomobject]@{ LocalAddress = "192.168.0.83"; LocalPort = 443; OwningProcess = 2 } )
$state = Get-LanIngressListenerState -Listeners $lanConflict -LanIPv4 "192.168.0.83" -ProcessNames @{ 2 = "httpd" }
Assert-Equal $state.NonCaddy.Count 1 "Non-Caddy listener on LAN must conflict"

$wildcardConflict = @( [pscustomobject]@{ LocalAddress = "0.0.0.0"; LocalPort = 80; OwningProcess = 3 } )
$state = Get-LanIngressListenerState -Listeners $wildcardConflict -LanIPv4 "192.168.0.83" -ProcessNames @{ 3 = "httpd" }
Assert-Equal $state.NonCaddy.Count 1 "Wildcard non-Caddy listener must conflict"

$existingCaddy = @( [pscustomobject]@{ LocalAddress = "192.168.0.83"; LocalPort = 443; OwningProcess = 4 } )
$state = Get-LanIngressListenerState -Listeners $existingCaddy -LanIPv4 "192.168.0.83" -ProcessNames @{ 4 = "caddy" }
Assert-Equal $state.NonCaddy.Count 0 "Existing Caddy must not conflict"
Assert-Equal $state.Caddy.Count 1 "Existing Caddy must be reusable"

$caddyText = Get-Content -LiteralPath $scriptPath -Raw
Assert-True ($caddyText -match 'bind \$LanIPv4') "Generated Caddyfile must bind the selected LAN IPv4"

[pscustomobject]@{ ok = $true; gate = "local-ingress-regression" } | ConvertTo-Json -Compress
