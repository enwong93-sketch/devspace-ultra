param(
    [ValidateSet("install", "status", "remove", "start", "restart")]
    [string]$Action = "status",
    [string]$ConfigDir = "$env:USERPROFILE\.devspace",
    [ValidateRange(0,30)]
    [int]$DeferredSeconds = 0
)

$ErrorActionPreference = "Stop"
$taskName = "DevSpace-Stable-Gateway"
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

function Wait-GatewayReady {
    param([ValidateRange(5,60)][int]$TimeoutSeconds = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Milliseconds 400
        try {
            $gateway = Invoke-GatewayHelper -Status
            if ($gateway.ok -eq $true -and $gateway.state -in @('already-running','ready','running-foreground','started')) {
                return $gateway
            }
        }
        catch {}
    } while ((Get-Date) -lt $deadline)
    throw "Stable Gateway did not become healthy within $TimeoutSeconds seconds."
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

        $taskArgs = '"{0}" --foreground --config-dir "{1}"' -f $helper, $configPath
        $taskAction = New-ScheduledTaskAction -Execute $node -Argument $taskArgs -WorkingDirectory $packageRoot
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $settings = New-ScheduledTaskSettingsSet `
            -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
            -RestartCount 3 `
            -RestartInterval (New-TimeSpan -Minutes 1) `
            -StartWhenAvailable `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries
        $principal = New-ScheduledTaskPrincipal `
            -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
            -LogonType Interactive `
            -RunLevel Limited
        Register-ScheduledTask `
            -TaskName $taskName `
            -Action $taskAction `
            -Trigger $trigger `
            -Settings $settings `
            -Principal $principal | Out-Null
        Start-ScheduledTask -TaskName $taskName
        Start-Sleep -Seconds 2
        $task = Get-GatewayTask
        $gateway = Invoke-GatewayHelper -Status
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
            Start-Sleep -Seconds 2
        }
        $gateway = Invoke-GatewayHelper -Status
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
        $gateway = Wait-GatewayReady -TimeoutSeconds 30
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
    "remove" {
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
        $gateway = Invoke-GatewayHelper -Status
        [ordered]@{
            Ok = $true
            State = "status"
            TaskName = $taskName
            TaskInstalled = ($null -ne $task)
            TaskState = if ($task) { $task.State.ToString() } else { $null }
            ConfigDir = $configPath
            Gateway = $gateway
            SecretValuesLogged = $false
        } | ConvertTo-Json -Depth 8 -Compress
    }
}
