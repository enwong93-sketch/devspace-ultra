[CmdletBinding()]
param(
    [ValidateSet("install", "status", "remove", "start")]
    [string]$Action = "status"
)

$ErrorActionPreference = "Stop"
$taskName = "DevSpace-Fixed-Edge-Tunnel"
$backendTaskName = "DevSpace-Fixed-Backend"
$packageRoot = Split-Path $PSScriptRoot -Parent
$helper = Join-Path $PSScriptRoot "devspace-edge-tunnel.mjs"
$backendHelper = Join-Path $PSScriptRoot "devspace-fixed-backend.mjs"
$node = (Get-Command node -ErrorAction Stop).Source

function Invoke-EdgeHelper {
    if (-not (Test-Path -LiteralPath $helper)) { throw "Fixed edge tunnel helper is missing: $helper" }
    $output = @(& $node $helper --start)
    if ($LASTEXITCODE -ne 0) { throw "Fixed edge tunnel helper failed: $($output -join "`n")" }
    ($output -join "`n").Trim()
}

function Invoke-BackendHelper {
    if (-not (Test-Path -LiteralPath $backendHelper)) { throw "Fixed backend helper is missing: $backendHelper" }
    $output = @(& $node $backendHelper)
    if ($LASTEXITCODE -ne 0) { throw "Fixed backend helper failed: $($output -join "`n")" }
    ($output -join "`n").Trim()
}

switch ($Action) {
    "install" {
        if (-not (Test-Path -LiteralPath $helper)) { throw "Fixed edge tunnel helper is missing: $helper" }
        if (-not (Test-Path -LiteralPath $backendHelper)) { throw "Fixed backend helper is missing: $backendHelper" }
        foreach ($existingTaskName in @($taskName, $backendTaskName)) {
            $existingTask = Get-ScheduledTask -TaskName $existingTaskName -ErrorAction SilentlyContinue
            if ($existingTask -and $existingTask.State -eq "Running") {
                Stop-ScheduledTask -TaskName $existingTaskName
            }
        }
        Start-Sleep -Milliseconds 750
        $quotedHelper = '"{0}"' -f $helper
        $quotedBackendHelper = '"{0}"' -f $backendHelper
        $taskAction = New-ScheduledTaskAction -Execute $node -Argument "$quotedHelper --foreground" -WorkingDirectory $packageRoot
        $backendTaskAction = New-ScheduledTaskAction -Execute $node -Argument "$quotedBackendHelper --foreground" -WorkingDirectory $packageRoot
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $settings = New-ScheduledTaskSettingsSet `
            -StartWhenAvailable `
            -MultipleInstances IgnoreNew `
            -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
        Register-ScheduledTask `
            -TaskName $taskName `
            -Action $taskAction `
            -Trigger $trigger `
            -Settings $settings `
            -Description "Start the DevSpace fixed Cloudflare Workers VPC named tunnel after logon. No credentials are stored in the task." `
            -Force | Out-Null
        Register-ScheduledTask `
            -TaskName $backendTaskName `
            -Action $backendTaskAction `
            -Trigger $trigger `
            -Settings $settings `
            -Description "Start the isolated DevSpace fixed backend after logon. Public identity, state directory, and accepted hosts are supplied only to the child process." `
            -Force | Out-Null
        Start-ScheduledTask -TaskName $backendTaskName
        Start-ScheduledTask -TaskName $taskName
        Start-Sleep -Seconds 4
        $backendStart = @(& $node $backendHelper --status) -join "`n"
        $start = @(& $node $helper --status) -join "`n"
        [ordered]@{
            Ok = $true
            State = "installed"
            TaskName = $taskName
            TaskState = (Get-ScheduledTask -TaskName $taskName).State.ToString()
            BackendTaskName = $backendTaskName
            BackendTaskState = (Get-ScheduledTask -TaskName $backendTaskName).State.ToString()
            Backend = $backendStart | ConvertFrom-Json
            Helper = $start | ConvertFrom-Json
            SecretValuesLogged = $false
        } | ConvertTo-Json -Depth 6 -Compress
    }
    "start" {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        $backendTask = Get-ScheduledTask -TaskName $backendTaskName -ErrorAction SilentlyContinue
        if ($backendTask) { Start-ScheduledTask -TaskName $backendTaskName }
        else { $null = Invoke-BackendHelper }
        if ($task) { Start-ScheduledTask -TaskName $taskName }
        else { $null = Invoke-EdgeHelper }
        Start-Sleep -Seconds 3
        $backendRaw = @(& $node $backendHelper --status) -join "`n"
        $tunnelRaw = @(& $node $helper --status) -join "`n"
        [ordered]@{
            Ok = $true
            Backend = ($backendRaw | ConvertFrom-Json)
            Tunnel = ($tunnelRaw | ConvertFrom-Json)
            SecretValuesLogged = $false
        } | ConvertTo-Json -Depth 6 -Compress
    }
    "status" {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        $backendTask = Get-ScheduledTask -TaskName $backendTaskName -ErrorAction SilentlyContinue
        $helperStatus = if (Test-Path -LiteralPath $helper) {
            $raw = @(& $node $helper --status)
            if ($LASTEXITCODE -eq 0) { (($raw -join "`n").Trim() | ConvertFrom-Json) } else { $null }
        } else { $null }
        $backendStatus = if (Test-Path -LiteralPath $backendHelper) {
            $rawBackend = @(& $node $backendHelper --status)
            if ($LASTEXITCODE -eq 0) { (($rawBackend -join "`n").Trim() | ConvertFrom-Json) } else { $null }
        } else { $null }
        [ordered]@{
            Ok = $true
            Installed = [bool]$task
            TaskName = $taskName
            TaskState = if ($task) { $task.State.ToString() } else { $null }
            BackendInstalled = [bool]$backendTask
            BackendTaskName = $backendTaskName
            BackendTaskState = if ($backendTask) { $backendTask.State.ToString() } else { $null }
            Backend = $backendStatus
            Tunnel = $helperStatus
            SecretValuesLogged = $false
        } | ConvertTo-Json -Depth 6 -Compress
    }
    "remove" {
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }
        if (Get-ScheduledTask -TaskName $backendTaskName -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $backendTaskName -Confirm:$false
        }
        [ordered]@{
            Ok = $true
            State = "removed"
            TaskName = $taskName
            BackendTaskName = $backendTaskName
            SecretValuesLogged = $false
        } | ConvertTo-Json -Depth 4 -Compress
    }
}
