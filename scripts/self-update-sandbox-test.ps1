[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($env:OS -ne "Windows_NT") {
    Write-Output '{"ok":true,"gate":"self-update-sandbox","skipped":true,"reason":"windows-only"}'
    exit 0
}

$root = Split-Path $PSScriptRoot -Parent
$updater = Join-Path $root "update.ps1"
$temp = Join-Path $env:TEMP ("devspace-self-update-test-" + [guid]::NewGuid().ToString('N'))
$archiveDir = Join-Path $temp "archive"
New-Item -ItemType Directory -Path $archiveDir -Force | Out-Null

function Get-ProductionSnapshot {
    $taskNames = @(
        "DevSpace-Stable-Gateway",
        "DevSpace-Fixed-Backend",
        "DevSpace-Local-Ingress",
        "DevSpace-Live-Progress-Overlay",
        "DevSpace-Canonical-Startup",
        "DevSpace-Ultra-Auto-Update"
    )
    $tasks = [ordered]@{}
    foreach ($name in $taskNames) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        $tasks[$name] = if ($task) { $task.State.ToString() } else { "missing" }
    }
    $listeners = [ordered]@{}
    foreach ($port in @(7678,7688,7689,9721,9732,9733,9734,9735)) {
        $connection = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
        $listeners[[string]$port] = if ($connection) { [int]$connection.OwningProcess } else { 0 }
    }
    return [ordered]@{ tasks = $tasks; listeners = $listeners }
}

function Assert-ProductionSnapshotUnchanged($Before, $After) {
    foreach ($name in $Before.tasks.Keys) {
        if ([string]$Before.tasks[$name] -ne [string]$After.tasks[$name]) {
            throw "Sandbox updater changed production Scheduled Task state: $name ($($Before.tasks[$name]) -> $($After.tasks[$name]))."
        }
    }
    foreach ($port in $Before.listeners.Keys) {
        if ([int]$Before.listeners[$port] -ne [int]$After.listeners[$port]) {
            throw "Sandbox updater changed production listener ownership on port $port ($($Before.listeners[$port]) -> $($After.listeners[$port]))."
        }
    }
}

function Write-FakePackage([string] $PackageRoot, [string] $Name, [string] $Version) {
    New-Item -ItemType Directory -Path $PackageRoot -Force | Out-Null
    @{ name = $Name; version = $Version } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PackageRoot "package.json") -Encoding utf8
    Set-Content -LiteralPath (Join-Path $PackageRoot "legacy-marker.txt") -Value "$Name@$Version" -Encoding utf8
}

function Read-Version([string] $PackageRoot) {
    return [string]((Get-Content -LiteralPath (Join-Path $PackageRoot "package.json") -Raw | ConvertFrom-Json).version)
}

try {
    $productionBefore = Get-ProductionSnapshot

    # Pure compatibility check: old Scheduled Task action paths must be
    # rewritable to the canonical package root without touching Task Scheduler.
    $env:DEVSPACE_UPDATE_LIBRARY_ONLY = "1"
    . $updater
    Remove-Item Env:DEVSPACE_UPDATE_LIBRARY_ONLY -ErrorAction SilentlyContinue
    $legacyTaskRoot = 'C:\legacy-prefix\node_modules\@waishnav\devspace'
    $canonicalTaskRoot = 'C:\legacy-prefix\node_modules\devspace-ultra'
    $convertedActions = @(Convert-TaskActions -ActionRows @([pscustomobject]@{
        Execute = 'powershell.exe'
        Arguments = "-File `"$legacyTaskRoot\scripts\devspace-canonical-startup.ps1`" -Action run"
        WorkingDirectory = $legacyTaskRoot
    }) -PackageRecords @([pscustomobject]@{ Root = $legacyTaskRoot }) -CanonicalRoot $canonicalTaskRoot)
    if ($convertedActions.Count -ne 1) { throw "Task-action conversion returned an unexpected action count." }
    if ([string]$convertedActions[0].Arguments -notlike "*$canonicalTaskRoot*") { throw "Legacy task arguments were not migrated to the canonical package root." }
    if ([string]$convertedActions[0].WorkingDirectory -ne $canonicalTaskRoot) { throw "Legacy task working directory was not migrated to the canonical package root." }

    Push-Location $root
    try {
        $archiveName = ((@(& npm.cmd pack --pack-destination $archiveDir --silent) | Select-Object -Last 1) -as [string]).Trim()
        if (-not $archiveName) { throw "npm pack did not return an archive name." }
    }
    finally { Pop-Location }
    $archive = Join-Path $archiveDir $archiveName
    if (-not (Test-Path -LiteralPath $archive)) { throw "npm pack archive is missing: $archive" }
    $targetVersion = [string]((Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version)

    # Case 1: migrate a legacy scoped installation to the canonical package root.
    $prefix1 = Join-Path $temp "prefix-legacy"
    $legacyRoot = Join-Path $prefix1 "node_modules\@waishnav\devspace"
    $state1 = Join-Path $temp "state-legacy"
    $backup1 = Join-Path $prefix1 "node_modules\.devspace-update-backups"
    New-Item -ItemType Directory -Path $prefix1 -Force | Out-Null
    Write-FakePackage -PackageRoot $legacyRoot -Name "@waishnav/devspace" -Version "0.3.0"
    Set-Content -LiteralPath (Join-Path $prefix1 "devspace.cmd") -Value "legacy-shim" -Encoding ascii
    $env:DEVSPACE_UPDATE_TEST_MODE = "1"
    Remove-Item Env:DEVSPACE_UPDATE_TEST_FAIL_AFTER_SWAP -ErrorAction SilentlyContinue
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $updater -Action apply -PackageArchive $archive -TargetVersion $targetVersion -NpmPrefix $prefix1 -UpdaterStateRoot $state1 -BackupRoot $backup1 -SkipRuntimeRestart -NoAutoUpdateTask -Quiet
    if ($LASTEXITCODE -ne 0) { throw "Legacy migration updater exited with $LASTEXITCODE." }
    $canonical1 = Join-Path $prefix1 "node_modules\devspace-ultra"
    if ((Read-Version $canonical1) -ne $targetVersion) { throw "Legacy migration did not install the target version." }
    if (Test-Path -LiteralPath $legacyRoot) { throw "Legacy scoped package root still exists after migration." }
    $status1 = Get-Content -LiteralPath (Join-Path $state1 "last-update.json") -Raw | ConvertFrom-Json
    if ([string]$status1.state -ne "completed") { throw "Legacy migration did not record completed status." }

    # Case 2: inject a post-swap verification failure and prove rollback restores package + shim.
    $prefix2 = Join-Path $temp "prefix-rollback"
    $oldRoot2 = Join-Path $prefix2 "node_modules\devspace-ultra"
    $state2 = Join-Path $temp "state-rollback"
    $backup2 = Join-Path $prefix2 "node_modules\.devspace-update-backups"
    New-Item -ItemType Directory -Path $prefix2 -Force | Out-Null
    Write-FakePackage -PackageRoot $oldRoot2 -Name "devspace-ultra" -Version "0.5.2"
    Set-Content -LiteralPath (Join-Path $prefix2 "devspace.cmd") -Value "rollback-shim" -Encoding ascii
    $env:DEVSPACE_UPDATE_TEST_FAIL_AFTER_SWAP = "1"
    $failed = $false
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $updater -Action apply -PackageArchive $archive -TargetVersion $targetVersion -NpmPrefix $prefix2 -UpdaterStateRoot $state2 -BackupRoot $backup2 -SkipRuntimeRestart -NoAutoUpdateTask -Quiet
        if ($LASTEXITCODE -ne 0) { $failed = $true }
    }
    catch { $failed = $true }
    if (-not $failed) { throw "Injected verification failure unexpectedly succeeded." }
    if ((Read-Version $oldRoot2) -ne "0.5.2") { throw "Rollback did not restore the old package version." }
    $shimText = (Get-Content -LiteralPath (Join-Path $prefix2 "devspace.cmd") -Raw).Trim()
    if ($shimText -ne "rollback-shim") { throw "Rollback did not restore the previous npm shim." }
    $status2 = Get-Content -LiteralPath (Join-Path $state2 "last-update.json") -Raw | ConvertFrom-Json
    if ([string]$status2.state -ne "rolled-back") { throw "Rollback did not record rolled-back status." }

    $productionAfter = Get-ProductionSnapshot
    Assert-ProductionSnapshotUnchanged -Before $productionBefore -After $productionAfter

    Write-Output (@{
        ok = $true
        gate = "self-update-sandbox"
        legacyFrom = "@waishnav/devspace@0.3.0"
        migratedTo = "devspace-ultra@$targetVersion"
        legacyLayoutMigration = $true
        legacyScheduledTaskPathMigration = $true
        releaseArchiveStagedBeforeSwap = $true
        rollbackPackageRestored = $true
        rollbackShimRestored = $true
        autoTaskSuppressedInSandbox = $true
        productionTasksUntouched = $true
        productionListenersUntouched = $true
    } | ConvertTo-Json -Compress)
}
finally {
    Remove-Item Env:DEVSPACE_UPDATE_LIBRARY_ONLY -ErrorAction SilentlyContinue
    Remove-Item Env:DEVSPACE_UPDATE_TEST_MODE -ErrorAction SilentlyContinue
    Remove-Item Env:DEVSPACE_UPDATE_TEST_FAIL_AFTER_SWAP -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
