[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Domain,
    [Parameter(Mandatory)] [string] $SecretPath,
    [Parameter(Mandatory)] [string] $StatusPath,
    [Parameter(Mandatory)] [string] $WanIPv4
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Read-ProtectedSecret([string] $Path) {
    $secure = Get-Content -LiteralPath $Path -Raw | ConvertTo-SecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Write-AtomicJson([string] $Path, $Value) {
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    $delay = 8
    while ($true) {
        try {
            Move-Item -LiteralPath $temporary -Destination $Path -Force
            break
        }
        catch {
            if ($_.Exception.HResult -notin @(-2147024891, -2147024864)) { throw }
            Start-Sleep -Milliseconds $delay
            $delay = [Math]::Min(250, [Math]::Ceiling($delay * 1.5))
        }
    }
}

$subdomain = $Domain.Trim().ToLowerInvariant() -replace '\.duckdns\.org$', ''
if ($subdomain -notmatch '^[a-z0-9-]{1,63}$') { throw "DuckDNS domain must be one subdomain label or a <name>.duckdns.org hostname." }
$parsedIp = $null
if (-not [Net.IPAddress]::TryParse($WanIPv4, [ref]$parsedIp) -or
    $parsedIp.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
    $WanIPv4 -in @('0.0.0.0', '255.255.255.255')) {
    throw 'An explicit router WAN IPv4 address is required; blank-IP DuckDNS updates are unsafe with a VPN.'
}
$octets = $parsedIp.GetAddressBytes()
if ($octets[0] -in @(0, 10, 127) -or $octets[0] -ge 224 -or
    ($octets[0] -eq 100 -and $octets[1] -ge 64 -and $octets[1] -le 127) -or
    ($octets[0] -eq 169 -and $octets[1] -eq 254) -or
    ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
    ($octets[0] -eq 192 -and $octets[1] -eq 168)) {
    throw 'Router WAN IPv4 is private, CGNAT, or reserved; refusing to publish it to DuckDNS.'
}
$token = Read-ProtectedSecret $SecretPath
try {
    $uri = "https://www.duckdns.org/update?domains=$([uri]::EscapeDataString($subdomain))&token=$([uri]::EscapeDataString($token))&ip=$([uri]::EscapeDataString($WanIPv4))"
    $response = Invoke-WebRequest -UseBasicParsing -Uri $uri -Method Get -TimeoutSec 10
    $body = if ($response.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($response.Content) } else { [string]$response.Content }
    $ok = (($body -split "\r?\n")[0]).Trim().ToUpperInvariant() -eq "OK"
    Write-AtomicJson $StatusPath ([ordered]@{
        ok = $ok
        domain = "$subdomain.duckdns.org"
        observedAt = [DateTime]::UtcNow.ToString("o")
        provider = "duckdns"
        secretLogged = $false
    })
    if (-not $ok) { throw "DuckDNS returned a non-success response." }
}
finally {
    $token = $null
}
