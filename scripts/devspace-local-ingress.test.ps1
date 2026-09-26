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

$testFile = New-TemporaryFile
try {
    $seed = @'
devspace-enwong.duckdns.org {
    bind 192.168.0.83
    route {
        # BEGIN CTC shared infrastructure route - product backend stays separate
        @ctc path /ctc/health /ctc/mcp
        handle @ctc {
            reverse_proxy 127.0.0.1:19150
        }
        # END CTC shared infrastructure route - product backend stays separate
    }
}
'@
    [IO.File]::WriteAllText($testFile.FullName, $seed, (New-Object Text.UTF8Encoding($false)))
    Write-CaddyConfig -DomainName "devspace-enwong.duckdns.org" -UpstreamPort 7678 -LanIPv4 "192.168.0.84" -Path $testFile.FullName
    $rebuilt = Get-Content -LiteralPath $testFile.FullName -Raw
    Assert-Equal ([regex]::Matches($rebuilt, '# BEGIN CTC shared infrastructure route')).Count 1 "CTC route must remain unique"
    Assert-Equal ([regex]::Matches($rebuilt, '# END CTC shared infrastructure route')).Count 1 "CTC route end must remain unique"
    Assert-True ($rebuilt.Contains('reverse_proxy 127.0.0.1:19150')) "CTC independent upstream must survive LAN rebinding"
    Assert-True ($rebuilt.Contains('reverse_proxy 127.0.0.1:7678')) "DevSpace upstream must survive LAN rebinding"
    Assert-True ($rebuilt.Contains('bind 192.168.0.84')) "New LAN binding must be applied"
    $ambiguous = $rebuilt + [Environment]::NewLine + "# BEGIN CTC shared infrastructure route - product backend stays separate"
    [IO.File]::WriteAllText($testFile.FullName, $ambiguous, (New-Object Text.UTF8Encoding($false)))
    $rejected = $false
    try { Write-CaddyConfig -DomainName "devspace-enwong.duckdns.org" -UpstreamPort 7678 -LanIPv4 "192.168.0.85" -Path $testFile.FullName }
    catch { $rejected = $true }
    Assert-True $rejected "Ambiguous CTC route markers must fail before rewriting the shared config"
    Assert-Equal (Get-Content -LiteralPath $testFile.FullName -Raw) $ambiguous "Ambiguous shared config must remain byte-for-byte unchanged"
}
finally {
    Remove-Item -LiteralPath $testFile.FullName -Force -ErrorAction SilentlyContinue
}

[pscustomobject]@{ ok = $true; gate = "local-ingress-regression" } | ConvertTo-Json -Compress
