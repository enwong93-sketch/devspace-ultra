$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$setup = Join-Path $PSScriptRoot 'devspace-public-setup.ps1'
. $setup

function Assert-True($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

Assert-True ((Normalize-DuckDnsHostname 'your-own-subdomain') -eq 'your-own-subdomain.duckdns.org') 'Bare DuckDNS subdomains must be completed with the DuckDNS suffix.'
Assert-True ((Normalize-DuckDnsHostname 'your-own-subdomain.duckdns.org') -eq 'your-own-subdomain.duckdns.org') 'Full DuckDNS hostnames must remain unchanged.'
$invalidDuckDnsRejected = $false
try { $null = Normalize-DuckDnsHostname 'example.com' } catch { $invalidDuckDnsRejected = $true }
Assert-True $invalidDuckDnsRejected 'A different public hostname must not be replaced by any shared default.'

$config = [pscustomobject]@{}
Set-Property $config 'allowedRoots' @('C:\Projects')
Set-Property $config 'allowedRoots' @('D:\Projects')
Assert-True (@($config.allowedRoots).Count -eq 1 -and $config.allowedRoots[0] -eq 'D:\Projects') 'Empty StrictMode config must support add and replace.'
Assert-True ($config.PSObject.Properties.Match('pluginPaths').Count -eq 0) 'Missing-property test must remain safe on an empty config.'

$priorLocalAppData = $env:LOCALAPPDATA
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('devspace-setup-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempRoot -ErrorAction Stop | Out-Null
try {
    $NonInteractive = $true
    $secretPath = Join-Path $tempRoot 'valid-secret.dpapi'
    $synthetic = ConvertTo-SecureString 'synthetic-test-only' -AsPlainText -Force
    Write-AtomicText $secretPath ($synthetic | ConvertFrom-SecureString)
    Assert-True ((Save-ProtectedSecret $secretPath 'DEVSPACE_TEST_SECRET_UNSET' 'unused') -eq $secretPath) 'Valid existing DPAPI secret must be reusable.'
    $invalidPath = Join-Path $tempRoot 'invalid-secret.dpapi'
    Write-AtomicText $invalidPath 'not-a-dpapi-payload'
    $invalidRejected = $false
    try { $null = Save-ProtectedSecret $invalidPath 'DEVSPACE_TEST_SECRET_UNSET' 'unused' } catch { $invalidRejected = $true }
    Assert-True $invalidRejected 'Invalid existing DPAPI secret must fail closed in non-interactive mode.'

    $env:LOCALAPPDATA = $tempRoot
    $links = Join-Path $tempRoot 'Microsoft\WinGet\Links'
    New-Item -ItemType Directory -Path $links -Force | Out-Null
    $name = 'devspace-test-caddy.exe'
    $link = Join-Path $links $name
    New-Item -ItemType File -Path $link -ErrorAction Stop | Out-Null
    Assert-True ((Find-WingetExecutable -Command $name -PackageId 'CaddyServer.Caddy') -eq $link) 'WinGet Links fallback failed.'

    Remove-Item -LiteralPath $link -Force
    $package = Join-Path $tempRoot 'Microsoft\WinGet\Packages\CaddyServer.Caddy_Test'
    New-Item -ItemType Directory -Path $package -Force | Out-Null
    $binary = Join-Path $package $name
    New-Item -ItemType File -Path $binary -ErrorAction Stop | Out-Null
    Assert-True ((Find-WingetExecutable -Command $name -PackageId 'CaddyServer.Caddy') -eq $binary) 'WinGet package-location fallback failed.'

}
finally {
    $env:LOCALAPPDATA = $priorLocalAppData
    $fullRoot = [System.IO.Path]::GetFullPath($tempRoot)
    $fullTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($fullRoot.StartsWith($fullTemp, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path $fullRoot -Leaf) -like 'devspace-setup-test-*') {
        Remove-Item -LiteralPath $fullRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

[pscustomobject]@{ ok=$true; gate='windows-public-setup-unit'; strictModeEmptyConfig=$true; wingetCaddyDiscovery=$true; dpapiReuseValidated=$true } | ConvertTo-Json -Compress
