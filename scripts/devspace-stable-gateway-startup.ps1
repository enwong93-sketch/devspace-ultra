param(
    [ValidateSet("install", "status", "remove", "start", "restart", "repair", "watchdog")]
    [string]$Action = "status",
    [string]$ConfigDir = "$env:USERPROFILE\.devspace",
    [ValidateRange(0,30)]
    [int]$DeferredSeconds = 0
)

$ErrorActionPreference = "Stop"
$taskName = "DevSpace-Stable-Gateway"
$watchdogTaskName = "DevSpace-Stable-Gateway-Watchdog"
$packageRoot = Split-Path $PSScriptRoot -Parent
$helper = Join-Path $PSScriptRoot "devspace-fixed-backend.mjs"
$node = (Get-Command node -ErrorAction Stop).Source
$configPath = [System.IO.Path]::GetFullPath($ConfigDir)

function Invoke-GatewayHelper {
    param([switch]$Status)
    $arguments = @($helper)
    if ($Status) { $arguments += "--status" }
    $arguments += @("--config-dir", $configPath)
    $raw = @(& $node @arguments) -join "`n"
    if (-not $raw) { throw "Stable Gateway helper returned no status." }
    return ($raw | ConvertFrom-Json)
}

function Get-GatewayTask {
    return Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
}

function New-GatewayTaskAction {
    $taskArgs = '"{0}" --foreground --config-dir "{1}"' -f $helper, $configPath
    return New-ScheduledTaskAction -Execute $node -Argument $taskArgs -WorkingDirectory $packageRoot
}

function New-GatewayTaskTriggers {
    return @(New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME)
}

function New-GatewayWatchdogTrigger {
    return New-ScheduledTaskTrigger `
        -Once `
        -At ((Get-Date).AddMinutes(1)) `
        -RepetitionInterval (New-TimeSpan -Minutes 1) `
        -RepetitionDuration (New-TimeSpan -Days 3650)
}

function New-GatewayTaskSettings {
    return New-ScheduledTaskSettingsSet `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -MultipleInstances IgnoreNew `
        -Priority 4 `
        -StartWhenAvailable `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries
}

function New-GatewayTaskPrincipal {
    return New-ScheduledTaskPrincipal `
        -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType Interactive `
        -RunLevel Limited
}

function Install-GatewayWatchdog {
    $watchdogArgs = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Action watchdog -ConfigDir "{1}"' -f $PSCommandPath, $configPath
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $watchdogArgs -WorkingDirectory $packageRoot
    $settings = New-ScheduledTaskSettingsSet `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
        -MultipleInstances IgnoreNew `
        -Priority 4 `
        -StartWhenAvailable `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries
    $principal = New-GatewayTaskPrincipal
    $existing = Get-ScheduledTask -TaskName $watchdogTaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Set-ScheduledTask -TaskName $watchdogTaskName -Action $action -Trigger (New-GatewayWatchdogTrigger) -Settings $settings -Principal $principal | Out-Null
    }
    else {
        Register-ScheduledTask -TaskName $watchdogTaskName -Action $action -Trigger (New-GatewayWatchdogTrigger) -Settings $settings -Principal $principal | Out-Null
    }
}

function Get-DedicatedListenerProcess {
    param([Parameter(Mandatory)][int]$Port)
    $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $connection) { return $null }
    return Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f [int]$connection.OwningProcess) -ErrorAction SilentlyContinue
}

function Stop-VerifiedDedicatedListener {
    param([Parameter(Mandatory)][int]$Port)
    $process = Get-DedicatedListenerProcess -Port $Port
    if (-not $process) { return $false }
    $command = [string]$process.CommandLine
    $isGateway = ($Port -eq 7678 -and $process.Name -eq "node.exe" -and $command -match 'devspace-(?:fixed-backend|stable-gateway)')
    $isCore = ($Port -in @(7688, 7689) -and $process.Name -eq "node.exe" -and $command -match 'dist[\\/]cli\.js' -and $command -match '\bserve\b')
    if (-not ($isGateway -or $isCore)) {
        throw "Refusing to stop unexpected listener on dedicated DevSpace port $Port (PID $($process.ProcessId))."
    }
    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    return $true
}

function Get-GatewayPorts {
    $configFile = Join-Path $configPath "config.json"
    $config = if (Test-Path -LiteralPath $configFile) {
        Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    }
    else { $null }
    $gatewayPort = if ($config -and $config.stableGatewayPort) { [int]$config.stableGatewayPort } elseif ($config -and $config.edgeBackendPort) { [int]$config.edgeBackendPort } else { 7678 }
    $coreA = if ($config -and $config.stableGatewayCoreAPort) { [int]$config.stableGatewayCoreAPort } else { $gatewayPort + 10 }
    $coreB = if ($config -and $config.stableGatewayCoreBPort) { [int]$config.stableGatewayCoreBPort } else { $gatewayPort + 11 }
    return [pscustomobject]@{ Gateway=$gatewayPort; Cores=@($coreA,$coreB) }
}

function Set-LiveGatewayPriorities {
    $ports = Get-GatewayPorts
    $changes = @()
    $gatewayListener = Get-NetTCPConnection -State Listen -LocalPort $ports.Gateway -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($gatewayListener) {
        $gatewayProcess = Get-Process -Id $gatewayListener.OwningProcess -ErrorAction SilentlyContinue
        if ($gatewayProcess) {
            try { $gatewayProcess.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::AboveNormal } catch {}
            $changes += [pscustomobject]@{ Role="gateway"; Pid=$gatewayProcess.Id; Priority=$gatewayProcess.PriorityClass.ToString() }
            $gatewayWmi = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $gatewayProcess.Id) -ErrorAction SilentlyContinue
            if ($gatewayWmi -and $gatewayWmi.ParentProcessId) {
                $launcher = Get-Process -Id $gatewayWmi.ParentProcessId -ErrorAction SilentlyContinue
                if ($launcher) {
                    try { $launcher.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::Normal } catch {}
                    $changes += [pscustomobject]@{ Role="launcher"; Pid=$launcher.Id; Priority=$launcher.PriorityClass.ToString() }
                }
            }
        }
    }
    foreach ($port in $ports.Cores) {
        $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $listener) { continue }
        $core = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
        if (-not $core) { continue }
        try { $core.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::Normal } catch {}
        $changes += [pscustomobject]@{ Role="core"; Pid=$core.Id; Priority=$core.PriorityClass.ToString(); Port=$port }
    }
    return @($changes)
}

function Wait-GatewayReady {
    while ($true) {
        Start-Sleep -Milliseconds 400
        try {
            $gateway = Invoke-GatewayHelper -Status
            if ($gateway.ok -eq $true -and $gateway.state -in @('already-running','ready','running-foreground','started')) {
                return $gateway
            }
        }
        catch {}
        $task = Get-GatewayTask
        $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
        $listener = Get-DedicatedListenerProcess -Port 7678
        if (-not $listener -and $task -and $task.State -ne "Running" -and $taskInfo -and $taskInfo.LastTaskResult -notin @(0,267009)) {
            throw "Stable Gateway task exited before readiness (LastTaskResult=$($taskInfo.LastTaskResult))."
        }
    }
}

if ($Action -eq "restart" -and $DeferredSeconds -gt 0) {
    Start-Sleep -Seconds $DeferredSeconds
}

switch ($Action) {
    "install" {
        $existing = Get-GatewayTask
        if ($existing) {
            if ($existing.State -eq "Running") {
                Stop-ScheduledTask -TaskName $taskName
                Start-Sleep -Milliseconds 700
            }
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }

        $taskAction = New-GatewayTaskAction
        $triggers = New-GatewayTaskTriggers
        $settings = New-GatewayTaskSettings
        $principal = New-GatewayTaskPrincipal
        Register-ScheduledTask `
            -TaskName $taskName `
            -Action $taskAction `
            -Trigger $triggers `
            -Settings $settings `
            -Principal $principal | Out-Null
        Install-GatewayWatchdog
        Start-ScheduledTask -TaskName $taskName
        $gateway = Wait-GatewayReady
        $task = Get-GatewayTask
        [ordered]@{
            Ok = ($gateway.ok -eq $true)
            State = "installed"
            TaskName = $taskName
            TaskState = if ($task) { $task.State.ToString() } else { $null }
            ConfigDir = $configPath
            Gateway = $gateway
            SecretValuesLogged = $false
        } | ConvertTo-Json -Depth 8 -Compress
    }
    "start" {
        $task = Get-GatewayTask
        if (-not $task) { throw "Scheduled Task $taskName is not installed." }
        if ($task.State -ne "Running") {
            Start-ScheduledTask -TaskName $taskName
        }
        $gateway = Wait-GatewayReady
        [ordered]@{
            Ok = ($gateway.ok -eq $true)
            State = "started"
            TaskName = $taskName
            TaskState = (Get-GatewayTask).State.ToString()
            ConfigDir = $configPath
            Gateway = $gateway
            SecretValuesLogged = $false
        } | ConvertTo-Json -Depth 8 -Compress
    }
    "restart" {
        $task = Get-GatewayTask
        if (-not $task) { throw "Scheduled Task $taskName is not installed." }

        if ($task.State -eq "Running") {
            Stop-ScheduledTask -TaskName $taskName
            Start-Sleep -Milliseconds 900
        }

        # Task Scheduler normally tears down its process tree, but verify and
        # clean only the three ports dedicated to this Stable Gateway runtime.
        foreach ($port in @(7678, 7688, 7689)) {
            $stopped = Stop-VerifiedDedicatedListener -Port $port
            if ($stopped) { Start-Sleep -Milliseconds 250 }
        }

        foreach ($port in @(7678, 7688, 7689)) {
            if (Get-DedicatedListenerProcess -Port $port) {
                throw "Dedicated DevSpace port $port is still occupied after verified restart cleanup."
            }
        }

        Start-ScheduledTask -TaskName $taskName
        $gateway = Wait-GatewayReady
        $taskAfter = Get-GatewayTask
        [ordered]@{
            Ok = ($gateway.ok -eq $true)
            State = "restarted"
            TaskName = $taskName
            TaskState = if ($taskAfter) { $taskAfter.State.ToString() } else { $null }
            ConfigDir = $configPath
            Gateway = $gateway
            SecretValuesLogged = $false
        } | ConvertTo-Json -Depth 8 -Compress
    }
    "repair" {
        $task = Get-GatewayTask
        if (-not $task) { throw "Scheduled Task $taskName is not installed." }
        $wasRunning = $task.State -eq "Running"
        Set-ScheduledTask `
            -TaskName $taskName `
            -Action (New-GatewayTaskAction) `
            -Trigger (New-GatewayTaskTriggers) `
            -Settings (New-GatewayTaskSettings) `
            -Principal (New-GatewayTaskPrincipal) | Out-Null
        Install-GatewayWatchdog
        $priorityState = Set-LiveGatewayPriorities
        $after = Get-GatewayTask
        [ordered]@{
            Ok = $true
            State = "repaired"
            TaskName = $taskName
            TaskState = if ($after) { $after.State.ToString() } else { $null }
            RunningInstancePreserved = ($wasRunning -and $after -and $after.State -eq "Running")
            RestartCount = 999
            Priority = 4
            MultipleInstances = "IgnoreNew"
            WatchdogTaskName = $watchdogTaskName
            WatchdogMinutes = 1
            RuntimePriorities = $priorityState
            ConfigDir = $configPath
            SecretValuesLogged = $false
        } | ConvertTo-Json -Depth 8 -Compress
    }
    "remove" {
        $watchdog = Get-ScheduledTask -TaskName $watchdogTaskName -ErrorAction SilentlyContinue
        if ($watchdog) {
            Stop-ScheduledTask -TaskName $watchdogTaskName -ErrorAction SilentlyContinue
            Unregister-ScheduledTask -TaskName $watchdogTaskName -Confirm:$false
        }
        $task = Get-GatewayTask
        if ($task) {
            if ($task.State -eq "Running") {
                Stop-ScheduledTask -TaskName $taskName
                Start-Sleep -Milliseconds 700
            }
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }
        [ordered]@{
            Ok = $true
            State = "removed"
            TaskName = $taskName
            ConfigDir = $configPath
            SecretValuesLogged = $false
        } | ConvertTo-Json -Compress
    }
    "status" {
        $task = Get-GatewayTask
        $watchdog = Get-ScheduledTask -TaskName $watchdogTaskName -ErrorAction SilentlyContinue
        $gateway = Invoke-GatewayHelper -Status
        [ordered]@{
            Ok = $true
            State = "status"
            TaskName = $taskName
            TaskInstalled = ($null -ne $task)
            TaskState = if ($task) { $task.State.ToString() } else { $null }
            WatchdogInstalled = ($null -ne $watchdog)
            WatchdogState = if ($watchdog) { $watchdog.State.ToString() } else { $null }
            ConfigDir = $configPath
            Gateway = $gateway
            SecretValuesLogged = $false
        } | ConvertTo-Json -Depth 8 -Compress
    }
    "watchdog" {
        $gateway = Invoke-GatewayHelper -Status
        if ($gateway.ok -eq $true -and $gateway.state -in @('already-running','ready','running-foreground','started')) {
            [ordered]@{ Ok=$true; State="healthy"; Started=$false; RuntimePriorities=(Set-LiveGatewayPriorities); SecretValuesLogged=$false } | ConvertTo-Json -Depth 5 -Compress
            break
        }
        $task = Get-GatewayTask
        if (-not $task) { throw "Scheduled Task $taskName is not installed." }
        $started = $false
        if ($task.State -ne "Running") {
            Start-ScheduledTask -TaskName $taskName
            $started = $true
        }
        [ordered]@{
            Ok = $true
            State = if ($started) { "recovery-started" } else { "unhealthy-task-running" }
            Started = $started
            TaskState = (Get-GatewayTask).State.ToString()
            SecretValuesLogged = $false
        } | ConvertTo-Json -Compress
    }
}
