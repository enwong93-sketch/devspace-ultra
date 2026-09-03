[CmdletBinding()]
param(
    [ValidateSet("status", "prepare-canary", "rollout")]
    [string]$Action = "status",

    [ValidateRange(1, 32)]
    [int]$CanaryWorker = 32,

    [string]$WorkerNumbers,

    [string]$ValidatedVersion,

    [ValidateRange(1024, 65000)]
    [int]$DebugBasePort = 9330
)

$ErrorActionPreference = "Stop"

$runtimeCloneScript = Join-Path $PSScriptRoot "chat-swarm-classic-runtime-clone.ps1"
$controllerScript = Join-Path $PSScriptRoot "chat-swarm-classic-controller.ps1"
$bootstrapScript = Join-Path $PSScriptRoot "chat-swarm-classic-cdp-bootstrap.mjs"
$stateRoot = Join-Path $env:LOCALAPPDATA "DevSpace\ChatSwarmClassic"
$controllerStatePath = Join-Path $stateRoot "controller-state.json"
$backupRootBase = Join-Path $stateRoot "update-backups"

$authStateItems = @(
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

function Get-PrimaryPackage {
    $package = Get-AppxPackage -Name "OpenAI.ChatGPT-Desktop" |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if (-not $package) { throw "OpenAI ChatGPT Classic package is not installed." }
    $package
}

function Get-WorkerRuntime {
    param([Parameter(Mandatory)][int]$Number)
    $packageName = "OpenAI.ChatGPT-Desktop.Worker{0:D2}" -f $Number
    $package = Get-AppxPackage -Name $packageName -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if (-not $package) {
        return [pscustomobject]@{
            Number = $Number
            WorkerId = "worker-{0:D2}" -f $Number
            PackageName = $packageName
            Registered = $false
            Version = $null
            InstallLocation = $null
            ExecutablePath = $null
            AliasPath = Join-Path $env:LOCALAPPDATA ("Microsoft\WindowsApps\chatgpt-classic-worker{0:D2}.exe" -f $Number)
            ProfilePath = $null
            DebugPort = $DebugBasePort + $Number
        }
    }
    [pscustomobject]@{
        Number = $Number
        WorkerId = "worker-{0:D2}" -f $Number
        PackageName = $packageName
        Registered = $true
        Version = [string]$package.Version
        InstallLocation = $package.InstallLocation
        ExecutablePath = Join-Path $package.InstallLocation "app\ChatGPT Classic.exe"
        AliasPath = Join-Path $env:LOCALAPPDATA ("Microsoft\WindowsApps\chatgpt-classic-worker{0:D2}.exe" -f $Number)
        ProfilePath = Join-Path $env:LOCALAPPDATA ("Packages\{0}\LocalCache\Roaming\ChatGPT" -f $package.PackageFamilyName)
        DebugPort = $DebugBasePort + $Number
    }
}

function Stop-WorkerRuntime {
    param([Parameter(Mandatory)]$Runtime)
    if (-not $Runtime.Registered) { return }
    Get-CimInstance Win32_Process |
        Where-Object { $_.Name -eq "ChatGPT Classic.exe" -and $_.ExecutablePath -eq $Runtime.ExecutablePath } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Test-TcpPort {
    param([Parameter(Mandatory)][int]$Port)
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $task = $client.ConnectAsync("127.0.0.1", $Port)
        if (-not $task.Wait(350)) { $client.Dispose(); return $false }
        $ok = $client.Connected
        $client.Dispose()
        return $ok
    }
    catch { return $false }
}

function Copy-StateItem {
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$TargetRoot,
        [Parameter(Mandatory)][string]$RelativePath
    )
    $source = Join-Path $SourceRoot $RelativePath
    if (-not (Test-Path -LiteralPath $source)) { return }
    $target = Join-Path $TargetRoot $RelativePath
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    $parent = Split-Path -Parent $target
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
}

function Copy-AuthState {
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$TargetRoot
    )
    New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null
    foreach ($item in $authStateItems) {
        Copy-StateItem -SourceRoot $SourceRoot -TargetRoot $TargetRoot -RelativePath $item
    }
}

function Read-ControllerState {
    if (-not (Test-Path -LiteralPath $controllerStatePath)) { return $null }
    try { Get-Content -LiteralPath $controllerStatePath -Raw | ConvertFrom-Json }
    catch { $null }
}

function Get-ProtectedWorkerNumbers {
    $state = Read-ControllerState
    if (-not $state -or $state.PSObject.Properties.Name -notcontains "protectedWorkers") { return @() }
    @($state.protectedWorkers | ForEach-Object { [int]$_ } | Where-Object { $_ -ge 1 -and $_ -le 32 } | Sort-Object -Unique)
}

function Assert-NotProtected {
    param(
        [Parameter(Mandatory)][int]$Number,
        [Parameter(Mandatory)][string]$Operation
    )
    if (@(Get-ProtectedWorkerNumbers) -contains $Number) {
        throw "worker-{0:D2} is a protected interactive runtime; refusing {1}. Move/unprotect the interactive conversation before this operation." -f $Number, $Operation
    }
}

function Parse-WorkerNumbers {
    $protected = @(Get-ProtectedWorkerNumbers)
    if (-not [string]::IsNullOrWhiteSpace($WorkerNumbers)) {
        $explicit = @($WorkerNumbers -split ',' | ForEach-Object {
            $n = 0
            if (-not [int]::TryParse($_.Trim(), [ref]$n) -or $n -lt 1 -or $n -gt 32) {
                throw "WorkerNumbers must contain integers from 1 to 32."
            }
            $n
        } | Sort-Object -Unique)
        foreach ($number in $explicit) { Assert-NotProtected -Number $number -Operation "update rollout" }
        return $explicit
    }

    $state = Read-ControllerState
    if (-not $state) { return @(1,2,3,4 | Where-Object { $protected -notcontains $_ }) }
    $desired = if ($state.PSObject.Properties.Name -contains "productionDesired") { [int]$state.productionDesired } else { 4 }
    $reserved = @()
    if ($state.PSObject.Properties.Name -contains "reservedWorkers") { $reserved = @($state.reservedWorkers | ForEach-Object { [int]$_ }) }
    $excluded = @($reserved + $protected | Sort-Object -Unique)
    $available = @(1..32 | Where-Object { $excluded -notcontains $_ })
    @($available | Select-Object -First $desired)
}

function Get-ConversationUrl {
    param([Parameter(Mandatory)][int]$Number)
    $state = Read-ControllerState
    if (-not $state) { return $null }
    $entry = @($state.workers | Where-Object { [int]$_.number -eq $Number } | Select-Object -First 1)
    if ($entry.Count -eq 0) { return $null }
    $url = [string]$entry[0].conversationUrl
    if ([string]::IsNullOrWhiteSpace($url)) { return $null }
    $url
}

function Backup-WorkerProfile {
    param(
        [Parameter(Mandatory)]$Runtime,
        [Parameter(Mandatory)][string]$BackupRoot
    )
    $target = Join-Path $BackupRoot $Runtime.WorkerId
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    Copy-AuthState -SourceRoot $Runtime.ProfilePath -TargetRoot $target
    $target
}

function Restore-WorkerProfile {
    param(
        [Parameter(Mandatory)]$Runtime,
        [Parameter(Mandatory)][string]$BackupPath
    )
    New-Item -ItemType Directory -Path $Runtime.ProfilePath -Force | Out-Null
    Copy-AuthState -SourceRoot $BackupPath -TargetRoot $Runtime.ProfilePath
}

function Start-Canary {
    param([Parameter(Mandatory)]$Runtime)
    if (-not (Test-Path -LiteralPath $Runtime.AliasPath)) { throw "Canary execution alias is missing." }
    Start-Process -FilePath $Runtime.AliasPath -ArgumentList @(
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=$($Runtime.DebugPort)"
    ) | Out-Null
    $deadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 400
        $root = Get-CimInstance Win32_Process |
            Where-Object { $_.Name -eq "ChatGPT Classic.exe" -and $_.ExecutablePath -eq $Runtime.ExecutablePath -and $_.CommandLine -notlike "*--type=*" } |
            Select-Object -First 1
    } while ((-not $root -or -not (Test-TcpPort -Port $Runtime.DebugPort)) -and (Get-Date) -lt $deadline)
    if (-not $root) { throw "Canary runtime did not start." }
    if (-not (Test-TcpPort -Port $Runtime.DebugPort)) { throw "Canary CDP port did not become ready." }
    $root
}

function Invoke-CanaryProbe {
    param([Parameter(Mandatory)]$Runtime)
    $node = (Get-Command node -ErrorAction Stop).Source
    $output = @(& $node $bootstrapScript --port $Runtime.DebugPort --probe --compact)
    if ($LASTEXITCODE -ne 0) { throw "Canary CDP probe failed with exit code $LASTEXITCODE." }
    ($output -join "`n") | ConvertFrom-Json
}

function Rollback-Worker {
    param(
        [Parameter(Mandatory)][int]$Number,
        [Parameter(Mandatory)][string]$OldManifest,
        [Parameter(Mandatory)][string]$BackupPath
    )
    Assert-NotProtected -Number $Number -Operation "rollback"
    $current = Get-WorkerRuntime -Number $Number
    Stop-WorkerRuntime -Runtime $current
    $package = Get-AppxPackage -Name $current.PackageName -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if ($package) { Remove-AppxPackage -Package $package.PackageFullName -ErrorAction Stop }
    Add-AppxPackage -Register $OldManifest -ErrorAction Stop
    $restored = Get-WorkerRuntime -Number $Number
    Restore-WorkerProfile -Runtime $restored -BackupPath $BackupPath
    $url = Get-ConversationUrl -Number $Number
    if ($url) {
        & $controllerScript -Action recover -Worker $Number | Out-Null
    }
    else {
        & $controllerScript -Action ensure -WorkerNumbers ([string]$Number) | Out-Null
    }
}

$primary = Get-PrimaryPackage
$primaryVersion = [string]$primary.Version

switch ($Action) {
    "status" {
        $workers = @(1..32 | ForEach-Object {
            $runtime = Get-WorkerRuntime -Number $_
            if ($runtime.Registered) {
                [pscustomobject]@{
                    Worker = $runtime.WorkerId
                    Number = $runtime.Number
                    Version = $runtime.Version
                    MatchesPrimary = ($runtime.Version -eq $primaryVersion)
                    Running = [bool](Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "ChatGPT Classic.exe" -and $_.ExecutablePath -eq $runtime.ExecutablePath } | Select-Object -First 1)
                }
            }
        })
        [pscustomobject]@{
            Ok = $true
            PrimaryVersion = $primaryVersion
            PrimaryInstallLocation = $primary.InstallLocation
            DriftCount = @($workers | Where-Object { -not $_.MatchesPrimary }).Count
            Workers = $workers
        } | ConvertTo-Json -Depth 6
    }

    "prepare-canary" {
        Assert-NotProtected -Number $CanaryWorker -Operation "update canary preparation"
        $state = Read-ControllerState
        if ($state) {
            $desired = if ($state.PSObject.Properties.Name -contains "productionDesired") { [int]$state.productionDesired } else { 4 }
            $reserved = if ($state.PSObject.Properties.Name -contains "reservedWorkers") { @($state.reservedWorkers | ForEach-Object { [int]$_ }) } else { @() }
            $protected = @(Get-ProtectedWorkerNumbers)
            $excluded = @($reserved + $protected | Sort-Object -Unique)
            $production = @(1..32 | Where-Object { $excluded -notcontains $_ } | Select-Object -First $desired)
            if ($production -contains $CanaryWorker) {
                throw "worker-{0:D2} is currently part of the production pool; choose a free canary worker number." -f $CanaryWorker
            }
        }

        $existing = Get-WorkerRuntime -Number $CanaryWorker
        if ($existing.Registered) { Stop-WorkerRuntime -Runtime $existing }
        & $runtimeCloneScript -Count 1 -FirstWorker $CanaryWorker -ForceRefresh | Out-Null
        # The normal controller lifecycle is authoritative for authentication too:
        # start the canary with CDP, then seed/verify its session from any currently
        # signed-in runtime using the in-memory CDP Session Seed path. No filesystem
        # auth seed or global chatgpt:// worker registration is required.
        & $controllerScript -Action start -WorkerNumbers ([string]$CanaryWorker) -EnableAutomation -NoMinimize | Out-Null
        & $controllerScript -Action ensure -WorkerNumbers ([string]$CanaryWorker) -NoMinimize | Out-Null
        $canary = Get-WorkerRuntime -Number $CanaryWorker
        $root = Get-CimInstance Win32_Process |
            Where-Object { $_.Name -eq "ChatGPT Classic.exe" -and $_.ExecutablePath -eq $canary.ExecutablePath -and $_.CommandLine -notlike "*--type=*" } |
            Select-Object -First 1
        if (-not $root) { throw "Canary runtime did not remain running after controller ensure." }
        $probe = Invoke-CanaryProbe -Runtime $canary
        $healthy = $probe.probe.composer -and -not $probe.probe.loginVisible
        [pscustomobject]@{
            Ok = [bool]$healthy
            CanaryWorker = $CanaryWorker
            WorkerId = $canary.WorkerId
            Version = $canary.Version
            PrimaryVersion = $primaryVersion
            Pid = $root.ProcessId
            DebugPort = $canary.DebugPort
            LoggedIn = -not [bool]$probe.probe.loginVisible
            Composer = [bool]$probe.probe.composer
            ConversationUrl = $probe.probe.href
        } | ConvertTo-Json -Depth 5
    }

    "rollout" {
        if ([string]::IsNullOrWhiteSpace($ValidatedVersion)) {
            throw "rollout requires -ValidatedVersion from a passed canary test."
        }
        if ($ValidatedVersion -ne $primaryVersion) {
            throw "ValidatedVersion $ValidatedVersion does not match the installed primary ChatGPT version $primaryVersion."
        }
        $targets = @(Parse-WorkerNumbers)
        $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $backupRoot = Join-Path $backupRootBase $timestamp
        New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
        $results = @()

        foreach ($number in $targets) {
            Assert-NotProtected -Number $number -Operation "update rollout"
            $old = Get-WorkerRuntime -Number $number
            if (-not $old.Registered) {
                $results += [pscustomobject]@{ Worker = "worker-{0:D2}" -f $number; State = "missing-skip"; Version = $null }
                continue
            }
            if ($old.Version -eq $primaryVersion) {
                $results += [pscustomobject]@{ Worker = $old.WorkerId; State = "already-current"; Version = $old.Version }
                continue
            }

            $oldManifest = Join-Path $old.InstallLocation "AppxManifest.xml"
            if (-not (Test-Path -LiteralPath $oldManifest)) { throw "Rollback manifest missing for $($old.WorkerId)." }
            # Stop the target before copying its Chromium profile. Network/Cookies
            # is SQLite-locked while Electron is alive; backing up first was both
            # unreliable and could leave an incomplete rollback image.
            Stop-WorkerRuntime -Runtime $old
            Start-Sleep -Milliseconds 700
            $backupPath = Backup-WorkerProfile -Runtime $old -BackupRoot $backupRoot
            try {
                & $runtimeCloneScript -Count 1 -FirstWorker $number -ForceRefresh | Out-Null
                $updated = Get-WorkerRuntime -Number $number
                Restore-WorkerProfile -Runtime $updated -BackupPath $backupPath
                $url = Get-ConversationUrl -Number $number
                if ($url) {
                    & $controllerScript -Action recover -Worker $number | Out-Null
                }
                else {
                    & $controllerScript -Action ensure -WorkerNumbers ([string]$number) | Out-Null
                }
                $verified = Get-WorkerRuntime -Number $number
                if ($verified.Version -ne $primaryVersion) {
                    throw "Version verification failed for $($verified.WorkerId): $($verified.Version)."
                }
                $results += [pscustomobject]@{ Worker = $verified.WorkerId; State = "updated"; Version = $verified.Version }
            }
            catch {
                Rollback-Worker -Number $number -OldManifest $oldManifest -BackupPath $backupPath
                throw "Update failed for worker-{0:D2}; rollback completed. {1}" -f $number, $_.Exception.Message
            }
        }

        [pscustomobject]@{
            Ok = $true
            ValidatedVersion = $ValidatedVersion
            PrimaryVersion = $primaryVersion
            BackupRoot = $backupRoot
            Results = $results
        } | ConvertTo-Json -Depth 6
    }
}
