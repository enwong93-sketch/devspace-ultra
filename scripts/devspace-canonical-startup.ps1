[CmdletBinding()]
param(
    [ValidateSet("install", "run", "status", "remove")]
    [string]$Action = "status",

    [ValidateRange(0, 120)]
    [int]$StaggerSeconds = 8
)

$ErrorActionPreference = "Stop"
$taskName = "DevSpace-Canonical-Startup"
$packageRoot = Split-Path $PSScriptRoot -Parent
$configDir = Join-Path $env:USERPROFILE ".devspace-tailscale-bootstrap"
$gatewayStartup = Join-Path $PSScriptRoot "devspace-stable-gateway-startup.ps1"
$ingressScript = Join-Path $PSScriptRoot "devspace-local-ingress.ps1"
$interactiveManager = Join-Path $PSScriptRoot "chat-classic-interactive-runtime.ps1"
$primaryAlias = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\chatgpt-classic.exe"
$primaryPort = 9721
$mainNumbers = @(2, 3, 4, 5)

function Test-TcpPort {
    param([Parameter(Mandatory)][int]$Port)
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $task = $client.ConnectAsync("127.0.0.1", $Port)
        if (-not $task.Wait(400)) { $client.Dispose(); return $false }
        $ok = $client.Connected
        $client.Dispose()
        return $ok
    }
    catch { return $false }
}

function Wait-TcpPort {
    param([Parameter(Mandatory)][int]$Port, [ValidateRange(5,120)][int]$TimeoutSeconds = 45)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if (Test-TcpPort -Port $Port) { return $true }
        Start-Sleep -Milliseconds 350
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Start-PrimaryMinimized {
    if (Test-TcpPort -Port $primaryPort) { return [pscustomobject]@{ State = "already-running"; Port = $primaryPort } }
    if (-not (Test-Path -LiteralPath $primaryAlias)) { throw "Canonical Main-01 alias is missing." }
    Start-Process -FilePath $primaryAlias -ArgumentList @("--remote-debugging-address=127.0.0.1", "--remote-debugging-port=$primaryPort") -WindowStyle Minimized | Out-Null
    if (-not (Wait-TcpPort -Port $primaryPort)) { throw "Main-01 did not become CDP-ready." }
    return [pscustomobject]@{ State = "started-minimized"; Port = $primaryPort }
}

function Start-SecondaryMain {
    param([Parameter(Mandatory)][int]$Number)
    $output = @(& $interactiveManager -Action start -MainNumber $Number -StartMinimized -VerifyTimeoutSeconds 45)
    $payload = ((($output -join "`n").Trim()) | ConvertFrom-Json)
    if (-not $payload.Ok -or -not $payload.Running -or -not $payload.SessionVerified) {
        throw "Main-{0:D2} failed its signed-in startup verification." -f $Number
    }
    if ($payload.WorkerManaged -or $payload.AutoCompactManaged -or $payload.ChatSwarmAutojoin) {
        throw "Main-{0:D2} violated the interactive-runtime isolation contract." -f $Number
    }
    return $payload
}

function Invoke-CanonicalStartup {
    if (-not (Test-Path -LiteralPath (Join-Path $configDir "config.json"))) { throw "Canonical DevSpace configuration is missing." }
    $gateway = ((@(& $gatewayStartup -Action start -ConfigDir $configDir) -join "`n") | ConvertFrom-Json)
    if (-not $gateway.Ok) { throw "Stable Gateway did not become healthy." }
    if (-not (Wait-TcpPort -Port 7678)) { throw "Stable Gateway listener did not become ready." }

    $ingress = ((@(& $ingressScript -Action status) -join "`n") | ConvertFrom-Json)
    if (-not $ingress.ok -or -not $ingress.tokenProtected) { throw "Local ingress is not configured with its protected local secret." }

    $primary = Start-PrimaryMinimized
    $secondaries = @()
    foreach ($number in $mainNumbers) {
        $secondaries += Start-SecondaryMain -Number $number
        if ($number -ne $mainNumbers[-1] -and $StaggerSeconds -gt 0) { Start-Sleep -Seconds $StaggerSeconds }
    }
    [ordered]@{
        Ok = $true
        State = "canonical-startup-ready"
        GatewayPort = 7678
        Primary = $primary
        Mains = $secondaries | ForEach-Object { [ordered]@{ Label = $_.Label; Port = $_.DebugPort; Pid = $_.Pid; SessionVerified = $_.SessionVerified } }
        WorkerAutostart = $false
        ForegroundActivation = $false
        SecretValuesLogged = $false
    }
}

switch ($Action) {
    "install" {
        $powershell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
        if (-not (Test-Path -LiteralPath $powershell)) { throw "Windows PowerShell host is missing: $powershell" }
        $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Action run -StaggerSeconds $StaggerSeconds"
        $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $packageRoot
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 1)
        $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal -Description "Start only canonical DevSpace services and Main-01 through Main-05, staggered and minimized; never starts Workers." -Force | Out-Null
        [ordered]@{ Ok = $true; State = "installed"; TaskName = $taskName; WorkerAutostart = $false; ForegroundActivation = $false } | ConvertTo-Json -Compress
    }
    "run" { Invoke-CanonicalStartup | ConvertTo-Json -Depth 8 -Compress }
    "status" {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        [ordered]@{ Ok = $true; State = "status"; TaskInstalled = [bool]$task; TaskState = if ($task) { $task.State.ToString() } else { $null }; GatewayReady = (Test-TcpPort -Port 7678); MainPortsReady = @(9721,9732,9733,9734,9735 | ForEach-Object { [ordered]@{ Port = $_; Ready = (Test-TcpPort -Port $_) } }); WorkerAutostart = $false; ForegroundActivation = $false } | ConvertTo-Json -Depth 6 -Compress
    }
    "remove" {
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
        [ordered]@{ Ok = $true; State = "removed"; TaskName = $taskName } | ConvertTo-Json -Compress
    }
}
