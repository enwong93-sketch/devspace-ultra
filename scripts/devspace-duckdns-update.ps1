[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Domain,
    [Parameter(Mandatory)] [string] $SecretPath,
    [Parameter(Mandatory)] [string] $StatusPath
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
$token = Read-ProtectedSecret $SecretPath
try {
    $uri = "https://www.duckdns.org/update?domains=$([uri]::EscapeDataString($subdomain))&token=$([uri]::EscapeDataString($token))&ip="
    $response = (Invoke-RestMethod -Uri $uri -Method Get).ToString().Trim()
    $ok = $response -eq "OK"
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
