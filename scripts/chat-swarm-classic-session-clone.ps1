[CmdletBinding()]
param(
    [ValidateRange(1, 32)]
    [int]$SourceWorker = 1,

    [ValidateRange(1, 32)]
    [int[]]$TargetWorkers = @(2, 3, 4),

    [switch]$Launch
)

$ErrorActionPreference = "Stop"

function Get-WorkerRuntime {
    param([Parameter(Mandatory)][int]$Worker)

    $suffix = "Worker{0:D2}" -f $Worker
    $packageName = "OpenAI.ChatGPT-Desktop.$suffix"
    $package = Get-AppxPackage -Name $packageName -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1

    if (-not $package) {
        throw "worker-{0:D2} runtime clone is not registered." -f $Worker
    }

    [pscustomobject]@{
        Worker = $Worker
        WorkerId = "worker-{0:D2}" -f $Worker
        PackageName = $packageName
        PackageFamilyName = $package.PackageFamilyName
        InstallLocation = $package.InstallLocation
        ExecutablePath = Join-Path $package.InstallLocation "app\ChatGPT Classic.exe"
        AliasPath = Join-Path $env:LOCALAPPDATA ("Microsoft\WindowsApps\chatgpt-classic-worker{0:D2}.exe" -f $Worker)
        ProfilePath = Join-Path $env:LOCALAPPDATA ("Packages\{0}\LocalCache\Roaming\ChatGPT" -f $package.PackageFamilyName)
    }
}

function Stop-WorkerRuntime {
    param([Parameter(Mandatory)]$Runtime)

    $processes = @(
        Get-CimInstance Win32_Process |
            Where-Object {
                $_.Name -eq "ChatGPT Classic.exe" -and
                $_.ExecutablePath -eq $Runtime.ExecutablePath
            }
    )

    foreach ($process in $processes) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Copy-StateItem {
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$TargetRoot,
        [Parameter(Mandatory)][string]$RelativePath
    )

    $source = Join-Path $SourceRoot $RelativePath
    $target = Join-Path $TargetRoot $RelativePath

    if (-not (Test-Path -LiteralPath $source)) {
        return
    }

    if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Recurse -Force
    }

    $parent = Split-Path -Parent $target
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
}

if ($TargetWorkers -contains $SourceWorker) {
    throw "SourceWorker cannot also appear in TargetWorkers."
}

$source = Get-WorkerRuntime -Worker $SourceWorker
$targets = @($TargetWorkers | Sort-Object -Unique | ForEach-Object { Get-WorkerRuntime -Worker $_ })

if (-not (Test-Path -LiteralPath $source.ProfilePath)) {
    throw "Source profile does not exist: $($source.ProfilePath)"
}
if (-not (Test-Path -LiteralPath (Join-Path $source.ProfilePath "IndexedDB"))) {
    throw "Source worker does not look authenticated yet: IndexedDB is missing. Log into $($source.WorkerId) first."
}

# Stop only the isolated worker clones. The user's primary ChatGPT package is
# never touched by this script.
Stop-WorkerRuntime -Runtime $source
foreach ($target in $targets) {
    Stop-WorkerRuntime -Runtime $target
}
Start-Sleep -Milliseconds 900

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupRoot = Join-Path $env:LOCALAPPDATA ("ChatGPT-Classic-Worker-Session-Backups\" + $timestamp)
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

# Browser/session state that carries the signed-in ChatGPT web identity. Cache,
# GPU, Crashpad, lock files and logs are intentionally excluded so each clone
# rebuilds its own ephemeral runtime state after launch.
$stateItems = @(
    "Local State",
    "Preferences",
    "config.json",
    "Network",
    "Local Storage",
    "IndexedDB",
    "Session Storage",
    "WebStorage",
    "shared_proto_db",
    "SharedStorage",
    "SharedStorage-wal",
    "Service Worker"
)

$results = @()
foreach ($target in $targets) {
    New-Item -ItemType Directory -Path $target.ProfilePath -Force | Out-Null

    $targetBackup = Join-Path $backupRoot $target.WorkerId
    New-Item -ItemType Directory -Path $targetBackup -Force | Out-Null
    foreach ($item in $stateItems) {
        $existing = Join-Path $target.ProfilePath $item
        if (Test-Path -LiteralPath $existing) {
            Copy-Item -LiteralPath $existing -Destination (Join-Path $targetBackup $item) -Recurse -Force
        }
    }

    foreach ($item in $stateItems) {
        Copy-StateItem -SourceRoot $source.ProfilePath -TargetRoot $target.ProfilePath -RelativePath $item
    }

    $results += [pscustomobject]@{
        WorkerId = $target.WorkerId
        ProfilePath = $target.ProfilePath
        IndexedDB = Test-Path -LiteralPath (Join-Path $target.ProfilePath "IndexedDB")
        Cookies = Test-Path -LiteralPath (Join-Path $target.ProfilePath "Network\Cookies")
        BackupPath = $targetBackup
        Launched = $false
    }
}

if ($Launch) {
    foreach ($target in @($source) + $targets) {
        if (-not (Test-Path -LiteralPath $target.AliasPath)) {
            throw "Execution alias is missing for $($target.WorkerId): $($target.AliasPath)"
        }
        Start-Process -FilePath $target.AliasPath -WorkingDirectory $env:LOCALAPPDATA | Out-Null
    }
    Start-Sleep -Seconds 3

    foreach ($result in $results) {
        $result.Launched = $true
    }
}

$results | Format-Table WorkerId, IndexedDB, Cookies, Launched, BackupPath -AutoSize
