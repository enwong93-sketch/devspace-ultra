[CmdletBinding()]
param(
    [ValidateRange(1, 32)]
    [int]$Count = 1,

    [ValidateRange(1, 32)]
    [int]$FirstWorker = 1,

    [switch]$ForceRefresh,

    [switch]$RepairExisting,

    [switch]$Launch
)

$ErrorActionPreference = "Stop"
$provisioner = Join-Path $PSScriptRoot "chat-classic-runtime-provision.ps1"
if (-not (Test-Path -LiteralPath $provisioner)) {
    throw "Role-aware ChatGPT Classic runtime provisioner is missing: $provisioner"
}

$arguments = @(
    "-Role", "worker",
    "-Count", [string]$Count,
    "-FirstNumber", [string]$FirstWorker
)
if ($ForceRefresh) { $arguments += "-ForceRefresh" }
if ($RepairExisting) { $arguments += "-RepairExisting" }
if ($Launch) { $arguments += "-Launch" }

$results = @(& $provisioner @arguments)
$results | Format-Table WorkerId, PackageName, Alias, Mode, Registration, Running, Launch -AutoSize
