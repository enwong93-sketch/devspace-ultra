[CmdletBinding()]
param(
    [string] $ConfigDir = "$env:USERPROFILE\.devspace-tailscale-bootstrap",
    [switch] $KeepAutoUpdateDisabled
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ($env:OS -ne "Windows_NT") {
    throw "This emergency recovery targets Windows only."
}

$gatewayTaskName = "DevSpace-Stable-Gateway"
$watchdogTaskName = "DevSpace-Stable-Gateway-Watchdog"
$autoUpdateTaskName = "DevSpace-Ultra-Auto-Update"
$releaseApi = "https://api.github.com/repos/enwong93-sketch/devspace-ultra/releases/latest"
$knownGoodCommit = "06327d673db8e1f37cb4df7d6077ea347ad9b3d9"
$knownGoodVersion = "0.5.8"
$configPath = [IO.Path]::GetFullPath($ConfigDir)
$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$evidenceRoot = Join-Path $configPath "logs\emergency-recovery-$stamp"
$launcherRoot = Join-Path $env:LOCALAPPDATA "DevSpaceUltra\HiddenLaunchers"
$resultPath = Join-Path $evidenceRoot "result.json"
$downloadedUpdater = Join-Path $env:TEMP "devspace-ultra-stable-updater-$stamp.ps1"
$sourceArchive = Join-Path $env:TEMP "devspace-ultra-known-good-$stamp.tar.gz"
$sourceExtractRoot = Join-Path $env:TEMP "devspace-ultra-known-good-$stamp"

New-Item -ItemType Directory -Path $evidenceRoot -Force | Out-Null
New-Item -ItemType Directory -Path $launcherRoot -Force | Out-Null
New-Item -ItemType Directory -Path $sourceExtractRoot -Force | Out-Null

$result = [ordered]@{
    schemaVersion = 2
    startedAt = (Get-Date).ToUniversalTime().ToString("o")
    state = "starting"
    configDir = $configPath
    evidenceRoot = $evidenceRoot
    targetVersion = $knownGoodVersion
    knownGoodCommit = $knownGoodCommit
    builtArchiveSha256 = $null
    packageRoot = $null
    localGatewayHealthy = $false
    gatewayPid = $null
    corePid = $null
    corePort = $null
    connectorReconnectMayStillBeRequired = $true
    blackConsoleTasksRewritten = @()
    secretValuesLogged = $false
}

function Write-AtomicJson {
    param([Parameter(Mandatory)][string] $Path, [Parameter(Mandatory)] $Value)
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Save-TaskEvidence {
    param([Parameter(Mandatory)][string] $TaskName)
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { return }
    try {
        Export-ScheduledTask -TaskName $TaskName | Set-Content -LiteralPath (Join-Path $evidenceRoot "$TaskName.xml") -Encoding Unicode
    }
    catch {}
}

function Stop-And-DisableTask {
    param([Parameter(Mandatory)][string] $TaskName)
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { return }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Disable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
}

function Get-InstalledPackageRoot {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction Stop }
    $prefix = (& $npm.Source prefix --global).Trim()
    if (-not $prefix) { throw "npm did not return a global prefix." }
    $candidates = @(
        (Join-Path $prefix "node_modules\devspace-ultra"),
        (Join-Path $prefix "node_modules\@waishnav\devspace")
    )
    foreach ($candidate in $candidates) {
        $manifest = Join-Path $candidate "package.json"
        if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { continue }
        try {
            $package = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
            if ([string]$package.name -in @("devspace-ultra", "@waishnav/devspace")) {
                return [IO.Path]::GetFullPath($candidate)
            }
        }
        catch {}
    }
    throw "No installed DevSpace Ultra package root was found."
}

function ConvertTo-VbsStringLiteral {
    param([Parameter(Mandatory)][string] $Text)
    return $Text.Replace('"', '""')
}

function Write-HiddenLauncher {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][string] $Executable,
        [Parameter(Mandatory)][string] $Arguments
    )
    $command = ('"{0}" {1}' -f $Executable, $Arguments).Trim()
    $encoded = ConvertTo-VbsStringLiteral -Text $command
    $content = @(
        'Option Explicit',
        'Dim shell, rc',
        'Set shell = CreateObject("WScript.Shell")',
        ('rc = shell.Run("{0}", 0, True)' -f $encoded),
        'WScript.Quit rc'
    ) -join "`r`n"
    Set-Content -LiteralPath $Path -Value $content -Encoding ASCII
}

function Set-HiddenTaskAction {
    param(
        [Parameter(Mandatory)][string] $TaskName,
        [Parameter(Mandatory)][string] $LauncherPath,
        [Parameter(Mandatory)][string] $WorkingDirectory
    )
    $null = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $wscript = Join-Path $env:WINDIR "System32\wscript.exe"
    $action = New-ScheduledTaskAction -Execute $wscript -Argument ('"{0}"' -f $LauncherPath) -WorkingDirectory $WorkingDirectory
    Set-ScheduledTask -TaskName $TaskName -Action $action -ErrorAction Stop | Out-Null
    Enable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null
    $result.blackConsoleTasksRewritten += $TaskName
}

function Wait-LocalGateway {
    param([int] $TimeoutSeconds = 90)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:7678/healthz" -TimeoutSec 3 -ErrorAction Stop
            if ($health.ok -eq $true) { return $health }
        }
        catch {
            try {
                $health = Invoke-RestMethod -Uri "http://127.0.0.1:7678/__devspace/gateway/healthz" -TimeoutSec 3 -ErrorAction Stop
                if ($health.ok -eq $true) { return $health }
            }
            catch {}
        }
        Start-Sleep -Seconds 2
    }
    throw "Stable Gateway did not become healthy within $TimeoutSeconds seconds."
}

try {
    foreach ($name in @($gatewayTaskName, $watchdogTaskName, $autoUpdateTaskName)) {
        Save-TaskEvidence -TaskName $name
    }

    # Stop the periodic interactive tasks before package replacement. They are
    # the recurring source most likely to flash console windows over the user.
    Stop-And-DisableTask -TaskName $watchdogTaskName
    Stop-And-DisableTask -TaskName $autoUpdateTaskName

    $headers = @{
        "User-Agent" = "DevSpace-Ultra-Emergency-Recovery/2"
        "Accept" = "application/vnd.github+json"
    }

    # Use the latest published updater only as the transactional installer.
    # The payload itself is rebuilt from the exact pre-regression commit below.
    $release = Invoke-RestMethod -Uri $releaseApi -Headers $headers -Method Get -UseBasicParsing
    if (-not $release -or $release.draft -eq $true -or $release.prerelease -eq $true) {
        throw "GitHub did not return a stable DevSpace Ultra release."
    }
    $updaterAsset = @($release.assets | Where-Object { [string]$_.name -eq "update.ps1" } | Select-Object -First 1)
    if ($updaterAsset.Count -ne 1) { throw "The stable release is missing update.ps1." }
    Invoke-WebRequest -Uri ([string]$updaterAsset[0].browser_download_url) -Headers $headers -OutFile $downloadedUpdater -UseBasicParsing
    $updaterDigest = [string]$updaterAsset[0].digest
    if ($updaterDigest -match '^sha256:([0-9a-fA-F]{64})$') {
        $actualUpdaterSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $downloadedUpdater).Hash.ToLowerInvariant()
        if ($actualUpdaterSha -ne $Matches[1].ToLowerInvariant()) {
            throw "Downloaded updater SHA-256 did not match the GitHub release digest."
        }
    }

    # Build a package from the exact PR #21 merge commit. This deliberately
    # excludes the later manual round-report hard gate while keeping the last
    # broadly working v0.5.8 Goal/Rescue baseline.
    $sourceUrl = "https://api.github.com/repos/enwong93-sketch/devspace-ultra/tarball/$knownGoodCommit"
    Invoke-WebRequest -Uri $sourceUrl -Headers $headers -OutFile $sourceArchive -UseBasicParsing
    $tar = Get-Command tar.exe -ErrorAction Stop
    & $tar.Source -xf $sourceArchive -C $sourceExtractRoot
    if ($LASTEXITCODE -ne 0) { throw "Known-good source extraction failed with code $LASTEXITCODE." }
    $sourcePackageRoots = @(Get-ChildItem -LiteralPath $sourceExtractRoot -Directory -ErrorAction Stop)
    if ($sourcePackageRoots.Count -ne 1) {
        throw "Known-good source archive did not contain exactly one package root."
    }
    $sourcePackageRoot = $sourcePackageRoots[0].FullName
    $sourceManifest = Get-Content -LiteralPath (Join-Path $sourcePackageRoot "package.json") -Raw | ConvertFrom-Json
    if ([string]$sourceManifest.name -ne "devspace-ultra" -or [string]$sourceManifest.version -ne $knownGoodVersion) {
        throw "Known-good source package identity/version mismatch."
    }
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction Stop }
    Push-Location $sourcePackageRoot
    try {
        $packOutput = @(& $npm.Source pack --ignore-scripts --pack-destination $sourceExtractRoot 2>&1)
        $packExitCode = $LASTEXITCODE
    }
    finally { Pop-Location }
    if ($packExitCode -ne 0) {
        throw "Known-good npm pack failed with code $packExitCode: $($packOutput -join ' ')"
    }
    $builtArchives = @(Get-ChildItem -LiteralPath $sourceExtractRoot -File -Filter "*.tgz" | Sort-Object LastWriteTimeUtc -Descending)
    if ($builtArchives.Count -ne 1) { throw "Known-good build did not produce exactly one npm archive." }
    $builtArchive = $builtArchives[0].FullName
    $builtArchiveSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $builtArchive).Hash.ToLowerInvariant()
    $result.builtArchiveSha256 = $builtArchiveSha

    # Force a same-version transactional repair from the known-good package.
    # The updater protects config/auth and targets only known DevSpace tasks and
    # package-root processes; it never stops ChatGPT Main or Blender.
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $downloadedUpdater `
        -Action apply `
        -PackageArchive $builtArchive `
        -TargetVersion $knownGoodVersion `
        -TargetTag "v0.5.8-known-good-06327d67" `
        -ExpectedSha256 $builtArchiveSha `
        -Force `
        -NoAutoUpdateTask
    if ($LASTEXITCODE -ne 0) {
        throw "Known-good transactional repair exited with code $LASTEXITCODE."
    }

    $packageRoot = Get-InstalledPackageRoot
    $result.packageRoot = $packageRoot
    $startup = Join-Path $packageRoot "scripts\devspace-stable-gateway-startup.ps1"
    $helper = Join-Path $packageRoot "scripts\devspace-fixed-backend.mjs"
    $installedUpdater = Join-Path $packageRoot "update.ps1"
    foreach ($path in @($startup, $helper, $installedUpdater)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Known-good package is missing required file: $path"
        }
    }

    # Restore canonical task settings, then replace every recurring console
    # action with a GUI-subsystem WScript launcher. This prevents both node.exe
    # and powershell.exe scheduled runs from flashing black windows.
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startup -Action repair -ConfigDir $configPath
    if ($LASTEXITCODE -ne 0) { throw "Stable Gateway task repair failed with code $LASTEXITCODE." }

    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $powershell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
    $mainLauncher = Join-Path $launcherRoot "stable-gateway.vbs"
    $watchdogLauncher = Join-Path $launcherRoot "stable-gateway-watchdog.vbs"
    $updateLauncher = Join-Path $launcherRoot "stable-auto-update.vbs"

    Write-HiddenLauncher -Path $mainLauncher -Executable $node -Arguments ('"{0}" --foreground --config-dir "{1}"' -f $helper, $configPath)
    Write-HiddenLauncher -Path $watchdogLauncher -Executable $powershell -Arguments ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Action watchdog -ConfigDir "{1}"' -f $startup, $configPath)
    Write-HiddenLauncher -Path $updateLauncher -Executable $powershell -Arguments ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Action apply -Automatic -Quiet' -f $installedUpdater)

    Set-HiddenTaskAction -TaskName $gatewayTaskName -LauncherPath $mainLauncher -WorkingDirectory $packageRoot
    Set-HiddenTaskAction -TaskName $watchdogTaskName -LauncherPath $watchdogLauncher -WorkingDirectory $packageRoot

    if ($KeepAutoUpdateDisabled) {
        Stop-And-DisableTask -TaskName $autoUpdateTaskName
    }
    else {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installedUpdater -Action install-task
        if ($LASTEXITCODE -ne 0) { throw "Auto-update task install failed with code $LASTEXITCODE." }
        Set-HiddenTaskAction -TaskName $autoUpdateTaskName -LauncherPath $updateLauncher -WorkingDirectory $packageRoot
    }

    $gatewayTask = Get-ScheduledTask -TaskName $gatewayTaskName -ErrorAction Stop
    if ($gatewayTask.State -ne "Running") {
        Start-ScheduledTask -TaskName $gatewayTaskName -ErrorAction Stop
    }
    $null = Wait-LocalGateway

    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -in @(7676, 7677, 7678, 7688, 7689) } |
        Sort-Object LocalPort)
    $gatewayListener = @($listeners | Where-Object LocalPort -eq 7678)
    $coreListeners = @($listeners | Where-Object { $_.LocalPort -in @(7688, 7689) })
    if ($gatewayListener.Count -ne 1) { throw "Expected exactly one Gateway listener on 7678." }
    if ($coreListeners.Count -ne 1) { throw "Expected exactly one Core listener on 7688 or 7689." }
    if (@($listeners | Where-Object { $_.LocalPort -in @(7676, 7677) }).Count -ne 0) {
        throw "Retired listeners 7676/7677 are unexpectedly present."
    }
    $memory = Invoke-RestMethod -Uri "http://127.0.0.1:7678/__devspace/memory/status" -TimeoutSec 5 -ErrorAction Stop
    if ([int]$memory.pid -ne [int]$coreListeners[0].OwningProcess) {
        throw "Core memory PID does not match the sole Core listener owner."
    }

    $result.state = "recovered"
    $result.completedAt = (Get-Date).ToUniversalTime().ToString("o")
    $result.localGatewayHealthy = $true
    $result.gatewayPid = [int]$gatewayListener[0].OwningProcess
    $result.corePid = [int]$coreListeners[0].OwningProcess
    $result.corePort = [int]$coreListeners[0].LocalPort
    $result.tasks = @(@($gatewayTaskName, $watchdogTaskName, $autoUpdateTaskName) | ForEach-Object {
        $taskName = [string]$_
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if (-not $task) {
            [ordered]@{ name = $taskName; present = $false }
        }
        else {
            $action = @($task.Actions)[0]
            [ordered]@{
                name = $taskName
                present = $true
                state = $task.State.ToString()
                enabled = ($task.State.ToString() -ne "Disabled")
                execute = if ($action) { [string]$action.Execute } else { $null }
                arguments = if ($action) { [string]$action.Arguments } else { $null }
            }
        }
    })
    Write-AtomicJson -Path $resultPath -Value $result
    $result | ConvertTo-Json -Depth 12
}
catch {
    $result.state = "failed"
    $result.failedAt = (Get-Date).ToUniversalTime().ToString("o")
    $result.error = $_.Exception.Message
    Write-AtomicJson -Path $resultPath -Value $result
    throw
}
finally {
    Remove-Item -LiteralPath $downloadedUpdater -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $sourceArchive -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $sourceExtractRoot -Recurse -Force -ErrorAction SilentlyContinue
}
