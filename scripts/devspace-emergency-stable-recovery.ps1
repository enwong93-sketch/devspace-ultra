[CmdletBinding()]
param(
    [string] $ConfigDir = "$env:USERPROFILE\.devspace-tailscale-bootstrap",
    [switch] $KeepAutoUpdateDisabled
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ($env:OS -ne "Windows_NT") { throw "This recovery script targets Windows only." }

$knownGoodCommit = "06327d673db8e1f37cb4df7d6077ea347ad9b3d9"
$knownGoodVersion = "0.5.8"
$gatewayTask = "DevSpace-Stable-Gateway"
$watchdogTask = "DevSpace-Stable-Gateway-Watchdog"
$updateTask = "DevSpace-Ultra-Auto-Update"
$configPath = [IO.Path]::GetFullPath($ConfigDir)
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$evidenceRoot = Join-Path $configPath "logs\emergency-recovery-$stamp"
$launcherRoot = Join-Path $env:LOCALAPPDATA "DevSpaceUltra\HiddenLaunchers"
$tempRoot = Join-Path $env:TEMP "devspace-known-good-$stamp"
$updaterPath = Join-Path $tempRoot "update.ps1"
$sourceArchive = Join-Path $tempRoot "source.tar.gz"
$extractRoot = Join-Path $tempRoot "source"
$resultPath = Join-Path $evidenceRoot "result.json"

New-Item -ItemType Directory -Path $evidenceRoot, $launcherRoot, $extractRoot -Force | Out-Null

$result = [ordered]@{
    schemaVersion = 3
    state = "starting"
    startedAt = (Get-Date).ToUniversalTime().ToString("o")
    knownGoodCommit = $knownGoodCommit
    targetVersion = $knownGoodVersion
    builtArchiveSha256 = $null
    packageRoot = $null
    localGatewayHealthy = $false
    gatewayPid = $null
    corePid = $null
    corePort = $null
    hiddenTasks = @()
    evidenceRoot = $evidenceRoot
    connectorReconnectMayStillBeRequired = $true
    secretValuesLogged = $false
}

function Write-AtomicJson([string] $Path, $Value) {
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Save-TaskEvidence([string] $Name) {
    if (-not (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue)) { return }
    try { Export-ScheduledTask -TaskName $Name | Set-Content (Join-Path $evidenceRoot "$Name.xml") -Encoding Unicode }
    catch {}
}

function Stop-DisableTask([string] $Name) {
    if (-not (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue)) { return }
    Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    Disable-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue | Out-Null
}

function Get-PackageRoot {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction Stop }
    $prefix = (& $npm.Source prefix --global).Trim()
    foreach ($candidate in @(
        (Join-Path $prefix "node_modules\devspace-ultra"),
        (Join-Path $prefix "node_modules\@waishnav\devspace")
    )) {
        $manifestPath = Join-Path $candidate "package.json"
        if (-not (Test-Path $manifestPath -PathType Leaf)) { continue }
        try {
            $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
            if ([string]$manifest.name -in @("devspace-ultra", "@waishnav/devspace")) {
                return [IO.Path]::GetFullPath($candidate)
            }
        }
        catch {}
    }
    throw "No installed DevSpace Ultra package root was found."
}

function Write-HiddenVbs([string] $Path, [string] $Executable, [string] $Arguments) {
    $command = ('"{0}" {1}' -f $Executable, $Arguments).Trim().Replace('"', '""')
    @(
        'Option Explicit',
        'Dim shell, rc',
        'Set shell = CreateObject("WScript.Shell")',
        ('rc = shell.Run("{0}", 0, True)' -f $command),
        'WScript.Quit rc'
    ) -join "`r`n" | Set-Content -LiteralPath $Path -Encoding ASCII
}

function Set-HiddenTask([string] $Name, [string] $VbsPath, [string] $WorkingDirectory) {
    $null = Get-ScheduledTask -TaskName $Name -ErrorAction Stop
    $wscript = Join-Path $env:WINDIR "System32\wscript.exe"
    $action = New-ScheduledTaskAction -Execute $wscript -Argument ('"{0}"' -f $VbsPath) -WorkingDirectory $WorkingDirectory
    Set-ScheduledTask -TaskName $Name -Action $action -ErrorAction Stop | Out-Null
    Enable-ScheduledTask -TaskName $Name -ErrorAction Stop | Out-Null
    $result.hiddenTasks += $Name
}

function Wait-Gateway([int] $TimeoutSeconds = 90) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        foreach ($uri in @("http://127.0.0.1:7678/healthz", "http://127.0.0.1:7678/__devspace/gateway/healthz")) {
            try {
                $health = Invoke-RestMethod -Uri $uri -TimeoutSec 3 -ErrorAction Stop
                if ($health.ok -eq $true) { return }
            }
            catch {}
        }
        Start-Sleep -Seconds 2
    }
    throw "Stable Gateway did not become healthy within $TimeoutSeconds seconds."
}

try {
    foreach ($name in @($gatewayTask, $watchdogTask, $updateTask)) { Save-TaskEvidence $name }
    Stop-DisableTask $watchdogTask
    Stop-DisableTask $updateTask

    $headers = @{
        "User-Agent" = "DevSpace-Ultra-Emergency-Recovery/3"
        "Accept" = "application/vnd.github+json"
    }

    # Use the published updater only for its protected transactional swap.
    $release = Invoke-RestMethod `
        -Uri "https://api.github.com/repos/enwong93-sketch/devspace-ultra/releases/latest" `
        -Headers $headers `
        -UseBasicParsing
    if (-not $release -or $release.draft -eq $true -or $release.prerelease -eq $true) {
        throw "GitHub did not return a stable release."
    }
    $updaterAsset = @($release.assets | Where-Object { $_.name -eq "update.ps1" } | Select-Object -First 1)
    if ($updaterAsset.Count -ne 1) { throw "Stable release update.ps1 is missing." }
    Invoke-WebRequest $updaterAsset[0].browser_download_url -Headers $headers -OutFile $updaterPath -UseBasicParsing
    if ([string]$updaterAsset[0].digest -match '^sha256:([0-9a-fA-F]{64})$') {
        $actualUpdaterSha = (Get-FileHash $updaterPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualUpdaterSha -ne $Matches[1].ToLowerInvariant()) { throw "Updater SHA-256 mismatch." }
    }

    # Rebuild the exact pre-regression PR #21 merge commit as a local package.
    Invoke-WebRequest `
        -Uri "https://api.github.com/repos/enwong93-sketch/devspace-ultra/tarball/$knownGoodCommit" `
        -Headers $headers `
        -OutFile $sourceArchive `
        -UseBasicParsing
    & (Get-Command tar.exe -ErrorAction Stop).Source -xf $sourceArchive -C $extractRoot
    if ($LASTEXITCODE -ne 0) { throw "Known-good source extraction failed with code $LASTEXITCODE." }
    $roots = @(Get-ChildItem $extractRoot -Directory)
    if ($roots.Count -ne 1) { throw "Known-good source archive must contain exactly one package root." }
    $sourceRoot = $roots[0].FullName
    $sourceManifest = Get-Content (Join-Path $sourceRoot "package.json") -Raw | ConvertFrom-Json
    if ($sourceManifest.name -ne "devspace-ultra" -or $sourceManifest.version -ne $knownGoodVersion) {
        throw "Known-good source identity/version mismatch."
    }
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction Stop }
    Push-Location $sourceRoot
    try {
        $packOutput = @(& $npm.Source pack --ignore-scripts --pack-destination $tempRoot 2>&1)
        $packExitCode = $LASTEXITCODE
    }
    finally { Pop-Location }
    if ($packExitCode -ne 0) {
        throw "Known-good npm pack failed with code ${packExitCode}: $($packOutput -join ' ')"
    }
    $archives = @(Get-ChildItem $tempRoot -File -Filter "*.tgz")
    if ($archives.Count -ne 1) { throw "Known-good build must produce exactly one npm archive." }
    $packageArchive = $archives[0].FullName
    $packageSha = (Get-FileHash $packageArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    $result.builtArchiveSha256 = $packageSha

    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $updaterPath `
        -Action apply `
        -PackageArchive $packageArchive `
        -TargetVersion $knownGoodVersion `
        -TargetTag "v0.5.8-known-good-06327d67" `
        -ExpectedSha256 $packageSha `
        -Force `
        -NoAutoUpdateTask
    if ($LASTEXITCODE -ne 0) { throw "Known-good transactional repair failed with code $LASTEXITCODE." }

    $packageRoot = Get-PackageRoot
    $result.packageRoot = $packageRoot
    $startup = Join-Path $packageRoot "scripts\devspace-stable-gateway-startup.ps1"
    $helper = Join-Path $packageRoot "scripts\devspace-fixed-backend.mjs"
    $installedUpdater = Join-Path $packageRoot "update.ps1"
    foreach ($requiredPath in @($startup, $helper, $installedUpdater)) {
        if (-not (Test-Path $requiredPath -PathType Leaf)) { throw "Known-good package is missing $requiredPath" }
    }

    # Repair settings, then replace all recurring console actions by GUI WScript.
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startup -Action repair -ConfigDir $configPath
    if ($LASTEXITCODE -ne 0) { throw "Stable Gateway task repair failed with code $LASTEXITCODE." }

    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $powershell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
    $mainVbs = Join-Path $launcherRoot "stable-gateway.vbs"
    $watchdogVbs = Join-Path $launcherRoot "stable-gateway-watchdog.vbs"
    $updateVbs = Join-Path $launcherRoot "stable-auto-update.vbs"
    Write-HiddenVbs $mainVbs $node ('"{0}" --foreground --config-dir "{1}"' -f $helper, $configPath)
    Write-HiddenVbs $watchdogVbs $powershell ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Action watchdog -ConfigDir "{1}"' -f $startup, $configPath)
    Write-HiddenVbs $updateVbs $powershell ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Action apply -Automatic -Quiet' -f $installedUpdater)
    Set-HiddenTask $gatewayTask $mainVbs $packageRoot
    Set-HiddenTask $watchdogTask $watchdogVbs $packageRoot

    if ($KeepAutoUpdateDisabled) {
        Stop-DisableTask $updateTask
    }
    else {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installedUpdater -Action install-task
        if ($LASTEXITCODE -ne 0) { throw "Auto-update task install failed with code $LASTEXITCODE." }
        Set-HiddenTask $updateTask $updateVbs $packageRoot
    }

    if ((Get-ScheduledTask $gatewayTask).State -ne "Running") { Start-ScheduledTask $gatewayTask }
    Wait-Gateway

    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -in @(7676, 7677, 7678, 7688, 7689) })
    $gateway = @($listeners | Where-Object LocalPort -eq 7678)
    $cores = @($listeners | Where-Object { $_.LocalPort -in @(7688, 7689) })
    if ($gateway.Count -ne 1) { throw "Expected exactly one Gateway listener on 7678." }
    if ($cores.Count -ne 1) { throw "Expected exactly one Core listener on 7688 or 7689." }
    if (@($listeners | Where-Object { $_.LocalPort -in @(7676, 7677) }).Count -ne 0) {
        throw "Retired listeners 7676/7677 are unexpectedly present."
    }
    $memory = Invoke-RestMethod "http://127.0.0.1:7678/__devspace/memory/status" -TimeoutSec 5
    if ([int]$memory.pid -ne [int]$cores[0].OwningProcess) {
        throw "Core memory PID does not match the sole Core listener owner."
    }

    $result.state = "recovered"
    $result.completedAt = (Get-Date).ToUniversalTime().ToString("o")
    $result.localGatewayHealthy = $true
    $result.gatewayPid = [int]$gateway[0].OwningProcess
    $result.corePid = [int]$cores[0].OwningProcess
    $result.corePort = [int]$cores[0].LocalPort
    $result.tasks = @(@($gatewayTask, $watchdogTask, $updateTask) | ForEach-Object {
        $task = Get-ScheduledTask $_ -ErrorAction SilentlyContinue
        if (-not $task) { return [ordered]@{ name = $_; present = $false } }
        $action = @($task.Actions)[0]
        [ordered]@{
            name = $_
            present = $true
            state = $task.State.ToString()
            execute = if ($action) { [string]$action.Execute } else { $null }
            arguments = if ($action) { [string]$action.Arguments } else { $null }
        }
    })
    Write-AtomicJson $resultPath $result
    $result | ConvertTo-Json -Depth 12
}
catch {
    $result.state = "failed"
    $result.failedAt = (Get-Date).ToUniversalTime().ToString("o")
    $result.error = $_.Exception.Message
    Write-AtomicJson $resultPath $result
    throw
}
finally {
    Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
