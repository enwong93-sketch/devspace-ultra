[CmdletBinding()]
param([Parameter(Mandatory)][string]$BaseUrl)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'devspace-local-ingress.ps1') -Action status
$service = [pscustomobject]@{
    ServiceType = 'urn:schemas-upnp-org:service:WANIPConnection:1'
    Control = "$BaseUrl/missing"
}
$missing = Get-PortMapping -Service $service -Port 80
if ($null -ne $missing) { throw 'UPnP fault 714 must mean a missing mapping.' }
$service.Control = "$BaseUrl/generic"
$rejected = $false
try { $null = Get-PortMapping -Service $service -Port 443 } catch { $rejected = $true }
if (-not $rejected) { throw 'Generic HTTP 500 must remain an error.' }
[pscustomobject]@{ ok=$true; gate='upnp-soap-loopback'; host=$PSVersionTable.PSVersion.ToString() } | ConvertTo-Json -Compress
