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
Assert-Equal (Get-UpnpFaultCode -Content '<s:Fault><detail><UPnPError><errorCode>714</errorCode></UPnPError></detail></s:Fault>') 714 "Only UPnP 714 identifies a missing mapping"
Assert-Equal (Get-UpnpFaultCode -Content '<errorCode>718</errorCode>') 718 "A mapping conflict must not be treated as missing"
Assert-Equal (Get-UpnpFaultCode -Content '<html>HTTP 500</html>') $null "Generic HTTP 500 is ambiguous"
Add-Type -AssemblyName System.Net.Http
$httpResponse = [System.Net.Http.HttpResponseMessage]::new([System.Net.HttpStatusCode]::InternalServerError)
try {
    $httpResponse.Content = [System.Net.Http.StringContent]::new('<errorCode>714</errorCode>')
    Assert-Equal (Get-UpnpFaultCode -Content (Get-UpnpFaultResponseText -Response $httpResponse)) 714 'PowerShell 7 HTTP response faults must be readable'
} finally { $httpResponse.Dispose() }
Assert-True (Test-PrivateLanGateway -Address '192.168.50.1') 'Physical home-router gateway must be eligible'
Assert-True (-not (Test-PrivateLanGateway -Address '198.51.100.1')) 'Non-LAN gateway must not be chosen'
Assert-True (-not (Test-PrivateLanGateway -Address '0.0.0.0')) 'WireGuard default route must not be chosen'
Assert-True (Test-PublicWanIPv4 -Address '8.8.8.8') 'Public router WAN IPv4 must be accepted'
Assert-True (-not (Test-PublicWanIPv4 -Address '100.64.0.8')) 'CGNAT or overlay IP must be rejected as WAN'
Assert-True (-not (Test-PublicWanIPv4 -Address '192.168.50.10')) 'LAN IPv4 must be rejected as WAN'
Assert-True (-not (Test-PublicWanIPv4 -Address '203.0.113.10')) 'Documentation-only IPv4 must be rejected as WAN'

$unicode = "乙太網路 3"
$roundTrip = [System.Text.Encoding]::UTF8.GetString([System.Text.Encoding]::UTF8.GetBytes($unicode))
Assert-Equal $roundTrip $unicode "UTF-8 LAN interface aliases must round-trip"

$overlayOnly = @( [pscustomobject]@{ LocalAddress = "100.64.0.8"; LocalPort = 443; OwningProcess = 1 } )
$state = Get-LanIngressListenerState -Listeners $overlayOnly -LanIPv4 "192.168.50.10" -ProcessNames @{ 1 = "overlay" }
Assert-Equal $state.Relevant.Count 0 "Overlay-only listener must not conflict with LAN ingress"

$lanConflict = @( [pscustomobject]@{ LocalAddress = "192.168.50.10"; LocalPort = 443; OwningProcess = 2 } )
$state = Get-LanIngressListenerState -Listeners $lanConflict -LanIPv4 "192.168.50.10" -ProcessNames @{ 2 = "httpd" }
Assert-Equal $state.NonCaddy.Count 1 "Non-Caddy listener on LAN must conflict"

$wildcardConflict = @( [pscustomobject]@{ LocalAddress = "0.0.0.0"; LocalPort = 80; OwningProcess = 3 } )
$state = Get-LanIngressListenerState -Listeners $wildcardConflict -LanIPv4 "192.168.50.10" -ProcessNames @{ 3 = "httpd" }
Assert-Equal $state.NonCaddy.Count 1 "Wildcard non-Caddy listener must conflict"

$existingCaddy = @( [pscustomobject]@{ LocalAddress = "192.168.50.10"; LocalPort = 443; OwningProcess = 4 } )
$state = Get-LanIngressListenerState -Listeners $existingCaddy -LanIPv4 "192.168.50.10" -ProcessNames @{ 4 = "caddy" }
Assert-Equal $state.NonCaddy.Count 0 "Existing Caddy must not conflict"
Assert-Equal $state.Caddy.Count 1 "Existing Caddy must be reusable"

$caddyText = Get-Content -LiteralPath $scriptPath -Raw
Assert-True ($caddyText -match 'bind \$LanIPv4') "Generated Caddyfile must bind the selected LAN IPv4"
Assert-True ($caddyText -match "charset=utf-8'") 'UPnP SOAP Content-Type must be accepted by PowerShell 5.1 and 7'
Assert-True ($caddyText -match 'UTF8.GetBytes\(\$body\)') 'UPnP SOAP body must be encoded deterministically'

$testFile = Join-Path ([IO.Path]::GetTempPath()) ("devspace-ingress-" + [guid]::NewGuid().ToString('N') + '.Caddyfile')
try {
    [IO.File]::WriteAllText($testFile, @'
example.duckdns.org {
    route {
        # BEGIN CTC shared infrastructure route - product backend stays separate
        handle_path /ctc/* { reverse_proxy 127.0.0.1:19150 }
        # END CTC shared infrastructure route - product backend stays separate
    }
}
'@)
    Write-CaddyConfig -DomainName 'example.duckdns.org' -UpstreamPort 7678 -LanIPv4 '192.168.50.10' -Path $testFile
    $updated = Get-Content -LiteralPath $testFile -Raw
    Assert-True ($updated -match 'reverse_proxy 127\.0\.0\.1:19150') 'CTC shared route must survive generated Caddyfile refresh'
    Assert-True ($updated -match 'bind 192\.168\.50\.10') 'Generated Caddyfile must bind LAN IP'
    [IO.File]::WriteAllText($testFile, 'example.duckdns.org { handle_path /ctc/* { reverse_proxy 127.0.0.1:19150 } }')
    $rejected = $false
    try { Write-CaddyConfig -DomainName 'example.duckdns.org' -UpstreamPort 7678 -LanIPv4 '192.168.50.10' -Path $testFile }
    catch { $rejected = $true }
    Assert-True $rejected 'Unmarked CTC routes must never be erased silently'
} finally {
    if (Test-Path -LiteralPath $testFile) { Remove-Item -LiteralPath $testFile -Force }
}

[pscustomobject]@{ ok = $true; gate = "local-ingress-regression" } | ConvertTo-Json -Compress
