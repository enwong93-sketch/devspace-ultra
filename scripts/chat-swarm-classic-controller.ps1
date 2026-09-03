[CmdletBinding()]
param(
    [ValidateSet("setup", "start", "scale", "plan", "ensure", "status", "minimize", "restore", "stop", "repair", "capture", "recover", "autojoin", "protect", "unprotect", "help")]
    [string]$Action = "status",

    [ValidateRange(1, 32)]
    [int]$Count = 4,

    [ValidateRange(1, 32)]
    [int]$FirstWorker = 1,

    [ValidateRange(1, 32)]
    [int]$Worker = 1,

    [string]$WorkerNumbers,

    [ValidateRange(0, 31)]
    [int]$DesiredWorkers = 4,

    [string]$ReservedWorkerNumbers = "",

    [string]$ProtectionReason = "interactive-main-conversation",

    [switch]$OverrideProtected,

    [string]$InviteCode,

    [string]$ProjectUrl,

    [ValidateRange(1024, 65000)]
    [int]$DebugBasePort = 9330,

    [ValidateRange(0, 120)]
    [int]$StaggerSeconds = 8,

    [switch]$EnableAutomation,

    [switch]$RestartForAutomation,

    [switch]$NoMinimize,

    [switch]$ForceRefresh
)

$ErrorActionPreference = "Stop"

$runtimeCloneScript = Join-Path $PSScriptRoot "chat-swarm-classic-runtime-clone.ps1"
$identityScript = Join-Path $PSScriptRoot "chat-swarm-classic-runtime-identity.ps1"
$sessionSeedScript = Join-Path $PSScriptRoot "chat-swarm-classic-session-seed.mjs"
$bootstrapScript = Join-Path $PSScriptRoot "chat-swarm-classic-cdp-bootstrap.mjs"
$stateRoot = Join-Path $env:LOCALAPPDATA "DevSpace\ChatSwarmClassic"
$statePath = Join-Path $stateRoot "controller-state.json"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ChatSwarmWindowApi {
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@ -ErrorAction SilentlyContinue

function Ensure-RuntimeIdentityTasks {
    if (-not (Test-Path -LiteralPath $identityScript)) { return }
    $guardTask = Get-ScheduledTask -TaskName "DevSpace-ChatGPT-Primary-Identity-Guard" -ErrorAction SilentlyContinue
    $healTask = Get-ScheduledTask -TaskName "DevSpace-ChatGPT-Worker-Identity-Heal" -ErrorAction SilentlyContinue
    if ($guardTask -and $healTask) { return }
    $previousPreference = $ErrorActionPreference
    try {
        # Native stderr redirected by Windows PowerShell 5 can become ErrorRecord
        # objects. Do not let one line bypass the explicit child exit-code check.
        $ErrorActionPreference = "Continue"
        $output = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $identityScript -Action install-guard 2>&1)
        $exitCode = if ($null -eq $LASTEXITCODE) { 1 } else { [int]$LASTEXITCODE }
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) {
        throw "Unable to install ChatGPT runtime identity guard tasks: $($output -join "`n")"
    }
}

function Get-ReservedWorkerNumbers {
    if (-not [string]::IsNullOrWhiteSpace($ReservedWorkerNumbers)) {
        return @($ReservedWorkerNumbers -split ',' | ForEach-Object {
            $value = 0
            if ([int]::TryParse($_.Trim(), [ref]$value) -and $value -ge 1 -and $value -le 32) { $value }
        } | Sort-Object -Unique)
    }
    $state = Read-ControllerState
    if ($state -and $state.PSObject.Properties.Name -contains "reservedWorkers") {
        return @($state.reservedWorkers | ForEach-Object { [int]$_ } | Where-Object { $_ -ge 1 -and $_ -le 32 } | Sort-Object -Unique)
    }
    @()
}

function Get-ProtectedWorkerNumbers {
    $state = Read-ControllerState
    if (-not $state -or $state.PSObject.Properties.Name -notcontains "protectedWorkers") { return @() }
    @($state.protectedWorkers | ForEach-Object { [int]$_ } | Where-Object { $_ -ge 1 -and $_ -le 32 } | Sort-Object -Unique)
}

function Test-WorkerProtected {
    param([Parameter(Mandatory)][int]$Number)
    @(Get-ProtectedWorkerNumbers) -contains $Number
}

function Assert-WorkerMutable {
    param(
        [Parameter(Mandatory)]$Runtime,
        [Parameter(Mandatory)][string]$Operation
    )
    if ((Test-WorkerProtected -Number $Runtime.Number) -and -not $OverrideProtected) {
        throw "$($Runtime.WorkerId) is a protected interactive runtime; refusing $Operation. Use -OverrideProtected only after the protected conversation has moved elsewhere."
    }
}

function Get-WorkerNumberRange {
    if (-not [string]::IsNullOrWhiteSpace($WorkerNumbers)) {
        $parsed = @($WorkerNumbers -split ',' | ForEach-Object {
            $value = 0
            if (-not [int]::TryParse($_.Trim(), [ref]$value) -or $value -lt 1 -or $value -gt 32) {
                throw "WorkerNumbers must contain integers from 1 to 32."
            }
            $value
        } | Sort-Object -Unique)
        if ($parsed.Count -eq 0) { throw "WorkerNumbers did not contain any valid worker numbers." }
        return $parsed
    }
    @($FirstWorker..($FirstWorker + $Count - 1))
}

function Get-ProductionWorkerNumbers {
    param([Parameter(Mandatory)][int]$Desired)
    $reserved = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($number in @(Get-ReservedWorkerNumbers)) { [void]$reserved.Add([int]$number) }
    foreach ($number in @(Get-ProtectedWorkerNumbers)) { [void]$reserved.Add([int]$number) }
    $available = @()
    for ($number = 1; $number -le 32; $number++) {
        if (-not $reserved.Contains($number)) { $available += $number }
    }
    if ($Desired -gt $available.Count) {
        throw "Requested $Desired production workers but only $($available.Count) runtime numbers are available after reserved/protected workers: $(@((Get-ReservedWorkerNumbers) + (Get-ProtectedWorkerNumbers)) -join ',')."
    }
    @($available | Select-Object -First $Desired)
}

function Get-WorkerRuntime {
    param([Parameter(Mandatory)][int]$Number)

    $suffix = "Worker{0:D2}" -f $Number
    $packageName = "OpenAI.ChatGPT-Desktop.$suffix"
    $package = Get-AppxPackage -Name $packageName -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1

    $aliasName = "chatgpt-classic-worker{0:D2}.exe" -f $Number
    $aliasPath = Join-Path $env:LOCALAPPDATA ("Microsoft\WindowsApps\" + $aliasName)

    if (-not $package) {
        return [pscustomobject]@{
            Number = $Number
            WorkerId = "worker-{0:D2}" -f $Number
            Label = "Runtime-{0:D2}" -f $Number
            PackageName = $packageName
            PackageFamilyName = $null
            InstallLocation = $null
            ExecutablePath = $null
            AliasPath = $aliasPath
            ProfilePath = $null
            DebugPort = $DebugBasePort + $Number
            Registered = $false
        }
    }

    [pscustomobject]@{
        Number = $Number
        WorkerId = "worker-{0:D2}" -f $Number
        Label = "Runtime-{0:D2}" -f $Number
        PackageName = $packageName
        PackageFamilyName = $package.PackageFamilyName
        InstallLocation = $package.InstallLocation
        ExecutablePath = Join-Path $package.InstallLocation "app\ChatGPT Classic.exe"
        AliasPath = $aliasPath
        ProfilePath = Join-Path $env:LOCALAPPDATA ("Packages\{0}\LocalCache\Roaming\ChatGPT" -f $package.PackageFamilyName)
        DebugPort = $DebugBasePort + $Number
        Registered = $true
    }
}

function Get-WorkerRootProcess {
    param([Parameter(Mandatory)]$Runtime)
    if (-not $Runtime.Registered) { return $null }

    Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -eq "ChatGPT Classic.exe" -and
            $_.ExecutablePath -eq $Runtime.ExecutablePath -and
            $_.CommandLine -notlike "*--type=*"
        } |
        Sort-Object CreationDate |
        Select-Object -First 1
}

function Test-TcpPort {
    param([Parameter(Mandatory)][int]$Port)
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $task = $client.ConnectAsync("127.0.0.1", $Port)
        if (-not $task.Wait(250)) { $client.Dispose(); return $false }
        $ok = $client.Connected
        $client.Dispose()
        return $ok
    }
    catch { return $false }
}

function Read-ControllerState {
    if (-not (Test-Path -LiteralPath $statePath)) { return $null }
    try { return (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json) }
    catch { return $null }
}

function Save-ControllerState {
    param([Parameter(Mandatory)][object[]]$Runtimes)
    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null

    # Merge instead of replacing so starting/recovering one worker does not
    # erase mappings for the rest of the production pool.
    $byNumber = @{}
    $existing = Read-ControllerState
    if ($existing) {
        foreach ($item in @($existing.workers)) {
            if ($null -eq $item.number) { continue }
            $byNumber[[int]$item.number] = [ordered]@{
                number = [int]$item.number
                workerId = [string]$item.workerId
                label = [string]$item.label
                packageName = [string]$item.packageName
                packageFamilyName = [string]$item.packageFamilyName
                profilePath = [string]$item.profilePath
                debugPort = [int]$item.debugPort
                conversationUrl = if ($item.PSObject.Properties.Name -contains "conversationUrl") { Convert-ToCanonicalConversationUrl -Url ([string]$item.conversationUrl) } else { $null }
            }
        }
    }

    foreach ($runtime in $Runtimes) {
        $prior = $byNumber[[int]$runtime.Number]
        $conversationUrl = if ($prior) { $prior.conversationUrl } else { $null }
        $byNumber[[int]$runtime.Number] = [ordered]@{
            number = $runtime.Number
            workerId = $runtime.WorkerId
            label = $runtime.Label
            packageName = $runtime.PackageName
            packageFamilyName = $runtime.PackageFamilyName
            profilePath = $runtime.ProfilePath
            debugPort = $runtime.DebugPort
            conversationUrl = $conversationUrl
        }
    }

    $existingProjectUrl = if ($existing -and $existing.PSObject.Properties.Name -contains "projectUrl") { [string]$existing.projectUrl } else { $null }
    $effectiveProjectUrl = if (-not [string]::IsNullOrWhiteSpace($ProjectUrl)) { $ProjectUrl.Trim() } else { $existingProjectUrl }
    if (-not [string]::IsNullOrWhiteSpace($effectiveProjectUrl) -and $effectiveProjectUrl -notmatch '^https://chatgpt\.com/g/g-p-[^/]+/project/?$') {
        throw "ProjectUrl must be a ChatGPT project URL like https://chatgpt.com/g/g-p-.../project"
    }

    $existingDesired = if ($existing -and $existing.PSObject.Properties.Name -contains "productionDesired") { [int]$existing.productionDesired } else { 4 }
    $existingProtected = if ($existing -and $existing.PSObject.Properties.Name -contains "protectedWorkers") { @($existing.protectedWorkers | ForEach-Object { [int]$_ }) } else { @() }
    $existingProtection = if ($existing -and $existing.PSObject.Properties.Name -contains "protection") { $existing.protection } else { [pscustomobject]@{} }
    $payload = [ordered]@{
        version = 5
        updatedAt = (Get-Date).ToString("o")
        debugBasePort = $DebugBasePort
        projectUrl = $effectiveProjectUrl
        reservedWorkers = @(Get-ReservedWorkerNumbers)
        protectedWorkers = @($existingProtected | Sort-Object -Unique)
        protection = $existingProtection
        productionDesired = $existingDesired
        workers = @($byNumber.Keys | Sort-Object | ForEach-Object { $byNumber[$_] })
    }
    $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statePath -Encoding UTF8
}

function Set-WorkerConversationUrl {
    param(
        [Parameter(Mandatory)]$Runtime,
        [Parameter(Mandatory)][string]$Url
    )
    $canonical = Convert-ToCanonicalConversationUrl -Url $Url
    if (-not $canonical) {
        throw "Refusing to store non-conversation or transient ChatGPT URL for $($Runtime.WorkerId): $Url"
    }
    $state = Read-ControllerState
    if (-not $state) { throw "Controller state is missing; run start/status setup first." }
    $entry = @($state.workers | Where-Object { [int]$_.number -eq [int]$Runtime.Number } | Select-Object -First 1)
    if ($entry.Count -eq 0) { throw "No controller state entry for $($Runtime.WorkerId)." }
    $worker = $entry[0]
    $worker | Add-Member -NotePropertyName conversationUrl -NotePropertyValue $canonical -Force
    $state.updatedAt = (Get-Date).ToString("o")
    $state.version = 5
    $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statePath -Encoding UTF8
}

function Set-ProductionDesired {
    param([Parameter(Mandatory)][int]$Desired)
    $state = Read-ControllerState
    if (-not $state) { throw "Controller state is missing." }
    $state | Add-Member -NotePropertyName productionDesired -NotePropertyValue $Desired -Force
    $state | Add-Member -NotePropertyName reservedWorkers -NotePropertyValue @(Get-ReservedWorkerNumbers) -Force
    if ($state.PSObject.Properties.Name -notcontains "protectedWorkers") { $state | Add-Member -NotePropertyName protectedWorkers -NotePropertyValue @() -Force }
    if ($state.PSObject.Properties.Name -notcontains "protection") { $state | Add-Member -NotePropertyName protection -NotePropertyValue ([pscustomobject]@{}) -Force }
    $state.updatedAt = (Get-Date).ToString("o")
    $state.version = 5
    $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statePath -Encoding UTF8
}

function Set-WorkerProtection {
    param(
        [Parameter(Mandatory)]$Runtime,
        [Parameter(Mandatory)][bool]$Enabled,
        [string]$Reason = "interactive-main-conversation"
    )
    $state = Read-ControllerState
    if (-not $state) {
        Save-ControllerState -Runtimes @($Runtime)
        $state = Read-ControllerState
    }
    $protected = [System.Collections.Generic.HashSet[int]]::new()
    if ($state.PSObject.Properties.Name -contains "protectedWorkers") {
        foreach ($number in @($state.protectedWorkers)) { [void]$protected.Add([int]$number) }
    }
    $protection = if ($state.PSObject.Properties.Name -contains "protection" -and $state.protection) { $state.protection } else { [pscustomobject]@{} }
    $key = [string]$Runtime.Number
    if ($Enabled) {
        [void]$protected.Add([int]$Runtime.Number)
        $url = Get-WorkerConversationUrl -Runtime $Runtime
        $record = [pscustomobject]@{
            reason = $Reason
            protectedAt = (Get-Date).ToString("o")
            conversationUrl = $url
            packageName = $Runtime.PackageName
        }
        $protection | Add-Member -NotePropertyName $key -NotePropertyValue $record -Force
    }
    else {
        [void]$protected.Remove([int]$Runtime.Number)
        $protection.PSObject.Properties.Remove($key)
    }
    $state | Add-Member -NotePropertyName protectedWorkers -NotePropertyValue @($protected | Sort-Object) -Force
    $state | Add-Member -NotePropertyName protection -NotePropertyValue $protection -Force
    $state.version = 5
    $state.updatedAt = (Get-Date).ToString("o")
    $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $statePath -Encoding UTF8
    [pscustomobject]@{
        Worker = $Runtime.WorkerId
        Protected = $Enabled
        Reason = if ($Enabled) { $Reason } else { $null }
        ConversationUrl = Get-WorkerConversationUrl -Runtime $Runtime
    }
}

function Get-ConfiguredProjectUrl {
    if (-not [string]::IsNullOrWhiteSpace($ProjectUrl)) {
        $candidate = $ProjectUrl.Trim()
        if ($candidate -notmatch '^https://chatgpt\.com/g/g-p-[^/]+/project/?$') {
            throw "ProjectUrl must be a ChatGPT project URL like https://chatgpt.com/g/g-p-.../project"
        }
        return $candidate.TrimEnd('/')
    }
    $state = Read-ControllerState
    if ($state -and $state.PSObject.Properties.Name -contains "projectUrl") {
        $saved = [string]$state.projectUrl
        if (-not [string]::IsNullOrWhiteSpace($saved)) { return $saved.TrimEnd('/') }
    }
    return $null
}

function Get-WorkerConversationUrl {
    param([Parameter(Mandatory)]$Runtime)
    $state = Read-ControllerState
    if (-not $state) { return $null }
    $entry = @($state.workers | Where-Object { [int]$_.number -eq [int]$Runtime.Number } | Select-Object -First 1)
    if ($entry.Count -eq 0) { return $null }
    $url = [string]$entry[0].conversationUrl
    if ([string]::IsNullOrWhiteSpace($url)) { return $null }
    return (Convert-ToCanonicalConversationUrl -Url $url)
}

function Start-WorkerRuntime {
    param(
        [Parameter(Mandatory)]$Runtime,
        [switch]$Automation,
        [switch]$ForceRestart
    )

    if (-not $Runtime.Registered) {
        throw "$($Runtime.WorkerId) is not registered. Run setup first."
    }
    if (-not (Test-Path -LiteralPath $Runtime.AliasPath)) {
        throw "Execution alias is missing for $($Runtime.WorkerId): $($Runtime.AliasPath)"
    }

    $root = Get-WorkerRootProcess -Runtime $Runtime
    $debugOnline = Test-TcpPort -Port $Runtime.DebugPort

    if ($root -and $Automation -and -not $debugOnline -and $ForceRestart) {
        Stop-WorkerRuntime -Runtime $Runtime
        Start-Sleep -Milliseconds 700
        $root = $null
    }

    if (-not $root) {
        $args = @()
        if ($Automation) {
            $args += "--remote-debugging-address=127.0.0.1"
            $args += "--remote-debugging-port=$($Runtime.DebugPort)"
        }
        if ($args.Count -gt 0) {
            Start-Process -FilePath $Runtime.AliasPath -ArgumentList $args | Out-Null
        }
        else {
            Start-Process -FilePath $Runtime.AliasPath | Out-Null
        }

        $deadline = (Get-Date).AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 350
            $root = Get-WorkerRootProcess -Runtime $Runtime
        } while (-not $root -and (Get-Date) -lt $deadline)

        if (-not $root) {
            throw "$($Runtime.WorkerId) did not start before timeout."
        }
    }

    if ($Automation) {
        $deadline = (Get-Date).AddSeconds(10)
        do {
            if (Test-TcpPort -Port $Runtime.DebugPort) { break }
            Start-Sleep -Milliseconds 300
        } while ((Get-Date) -lt $deadline)
    }

    $process = Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue
    [pscustomobject]@{
        WorkerId = $Runtime.WorkerId
        Pid = $root.ProcessId
        Responding = [bool]$process.Responding
        DebugPort = $Runtime.DebugPort
        Automation = (Test-TcpPort -Port $Runtime.DebugPort)
        WindowHandle = [long]$process.MainWindowHandle
        WindowTitle = $process.MainWindowTitle
    }
}

function Stop-WorkerRuntime {
    param([Parameter(Mandatory)]$Runtime)
    if (-not $Runtime.Registered) { return }
    Assert-WorkerMutable -Runtime $Runtime -Operation "stop"

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

function Set-WorkerWindowState {
    param(
        [Parameter(Mandatory)]$Runtime,
        [ValidateSet("minimize", "restore")][string]$Mode
    )
    $root = Get-WorkerRootProcess -Runtime $Runtime
    if (-not $root) { return $false }
    $process = Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue
    if (-not $process -or $process.MainWindowHandle -eq 0) { return $false }

    if ($Mode -eq "minimize") {
        if ((Test-WorkerProtected -Number $Runtime.Number) -and -not $OverrideProtected) { return $false }
        return [ChatSwarmWindowApi]::ShowWindow([IntPtr]$process.MainWindowHandle, 6)
    }

    [void][ChatSwarmWindowApi]::ShowWindow([IntPtr]$process.MainWindowHandle, 9)
    [void][ChatSwarmWindowApi]::SetForegroundWindow([IntPtr]$process.MainWindowHandle)
    return $true
}

function Get-WorkerStatusRow {
    param([Parameter(Mandatory)]$Runtime)
    $root = Get-WorkerRootProcess -Runtime $Runtime
    $process = if ($root) { Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue } else { $null }
    $profile = $Runtime.ProfilePath

    [pscustomobject]@{
        Worker = $Runtime.WorkerId
        Registered = $Runtime.Registered
        Running = [bool]$root
        Pid = if ($root) { $root.ProcessId } else { $null }
        Responding = if ($process) { [bool]$process.Responding } else { $false }
        LoggedInState = if (Test-TcpPort -Port $Runtime.DebugPort) { Test-WorkerSignedIn -Runtime $Runtime } else { $null }
        Automation = Test-TcpPort -Port $Runtime.DebugPort
        DebugPort = $Runtime.DebugPort
        WindowTitle = if ($process) { $process.MainWindowTitle } else { "" }
        Protected = Test-WorkerProtected -Number $Runtime.Number
    }
}

function Get-WorkerLoginProbe {
    param([Parameter(Mandatory)]$Runtime)
    if (-not (Test-TcpPort -Port $Runtime.DebugPort)) { return $null }
    try { return (Invoke-CdpHelper -Runtime $Runtime -Arguments @("--probe", "--compact")).probe }
    catch { return $null }
}

function Test-WorkerSignedIn {
    param([Parameter(Mandatory)]$Runtime)
    $probe = Get-WorkerLoginProbe -Runtime $Runtime
    [bool]($probe -and $probe.composer -and -not $probe.loginVisible)
}

function Find-SessionSeedSource {
    param([Parameter(Mandatory)]$TargetRuntime)
    # A protected interactive runtime is valid as a read-only cookie source. It is
    # never stopped, navigated or modified by session seeding; CDP only reads the
    # allowlisted ChatGPT/OpenAI cookie jar in memory.
    foreach ($number in 1..32) {
        if ($number -eq $TargetRuntime.Number) { continue }
        $candidate = Get-WorkerRuntime -Number $number
        if (-not $candidate.Registered -or -not (Get-WorkerRootProcess -Runtime $candidate)) { continue }
        if (-not (Test-TcpPort -Port $candidate.DebugPort)) { continue }
        if (Test-WorkerSignedIn -Runtime $candidate) { return $candidate }
    }
    return $null
}

function Seed-WorkerSession {
    param(
        [Parameter(Mandatory)]$SourceRuntime,
        [Parameter(Mandatory)]$TargetRuntime
    )
    if (-not (Test-Path -LiteralPath $sessionSeedScript)) { throw "Session seed helper is missing: $sessionSeedScript" }
    if (-not (Test-TcpPort -Port $SourceRuntime.DebugPort)) { throw "$($SourceRuntime.WorkerId) seed source CDP is offline." }
    if (-not (Test-TcpPort -Port $TargetRuntime.DebugPort)) { throw "$($TargetRuntime.WorkerId) target CDP is offline." }
    $node = (Get-Command node -ErrorAction Stop).Source
    $output = @(& $node $sessionSeedScript --source-port $SourceRuntime.DebugPort --target-port $TargetRuntime.DebugPort --verify-seconds 15)
    if ($LASTEXITCODE -ne 0) { throw "Session seed failed for $($TargetRuntime.WorkerId)." }
    $text = ($output -join "`n").Trim()
    try { $result = $text | ConvertFrom-Json }
    catch { throw "Session seed returned invalid JSON for $($TargetRuntime.WorkerId)." }
    if (-not $result.ok -or -not $result.targetVerified) { throw "Session seed did not verify a signed-in target for $($TargetRuntime.WorkerId)." }
    return $result
}

function Ensure-WorkerAuthenticated {
    param([Parameter(Mandatory)]$Runtime)
    if (Test-WorkerSignedIn -Runtime $Runtime) {
        return [pscustomobject]@{ State = "already-signed-in"; SourceWorker = $null; CookieCount = 0 }
    }
    $source = Find-SessionSeedSource -TargetRuntime $Runtime
    if (-not $source) {
        throw "$($Runtime.WorkerId) is signed out and no verified signed-in CDP runtime is available as a session seed source. Sign in one runtime once, then retry."
    }
    $seed = Seed-WorkerSession -SourceRuntime $source -TargetRuntime $Runtime
    return [pscustomobject]@{ State = "session-seeded"; SourceWorker = $source.WorkerId; CookieCount = [int]$seed.transferredCookies }
}

function Ensure-OneRuntime {
    param([Parameter(Mandatory)]$Runtime)
    if ((Test-WorkerProtected -Number $Runtime.Number) -and -not $OverrideProtected) {
        $status = Get-WorkerStatusRow -Runtime $Runtime
        return [pscustomobject]@{
            Worker = $Runtime.WorkerId
            Label = $Runtime.Label
            State = "protected-skip"
            Running = $status.Running
            Responding = $status.Responding
            LoggedIn = $status.LoggedInState
            Automation = $status.Automation
            ConversationUrl = Get-WorkerConversationUrl -Runtime $Runtime
        }
    }
    $url = Get-WorkerConversationUrl -Runtime $Runtime
    $root = Get-WorkerRootProcess -Runtime $Runtime
    $automation = Test-TcpPort -Port $Runtime.DebugPort
    $state = "healthy"
    $probe = $null

    if (-not $root -or -not $automation) {
        if ($root) { Stop-WorkerRuntime -Runtime $Runtime; Start-Sleep -Milliseconds 500 }
        $null = Start-WorkerRuntime -Runtime $Runtime -Automation -ForceRestart
        $state = "started"
    }

    $auth = Ensure-WorkerAuthenticated -Runtime $Runtime
    if ($auth.State -eq "session-seeded") {
        $state = if ($state -eq "started") { "started-session-seeded" } else { "session-seeded" }
    }

    if ($url) {
        $probeResult = Invoke-CdpHelper -Runtime $Runtime -Arguments @("--probe", "--compact")
        $currentUrl = Convert-ToCanonicalConversationUrl -Url ([string]$probeResult.probe.href)
        if ($currentUrl -ne $url) {
            $cleanup = Invoke-CdpHelper -Runtime $Runtime -Arguments @("--dismiss-only", "--compact", "--label", $Runtime.Label, "--conversation-url", $url)
            $probe = $cleanup.afterDismiss
            $state = if ($state -eq "started") { "started-restored" } else { "restored" }
        }
        else {
            $cleanup = Invoke-CdpHelper -Runtime $Runtime -Arguments @("--dismiss-only", "--compact", "--label", $Runtime.Label)
            $probe = $cleanup.afterDismiss
        }
        if ($probe.connectionInterrupted) {
            $null = Invoke-CdpHelper -Runtime $Runtime -Arguments @("--interrupt-only", "--compact", "--label", $Runtime.Label, "--conversation-url", $url)
            Start-Sleep -Milliseconds 350
            $null = Invoke-CdpHelper -Runtime $Runtime -Arguments @("--resume", "--compact", "--label", $Runtime.Label, "--conversation-url", $url)
            $state = "interrupted-resume-sent"
        }
        elseif (-not $probe.generating) {
            $null = Invoke-CdpHelper -Runtime $Runtime -Arguments @("--resume", "--compact", "--label", $Runtime.Label, "--conversation-url", $url)
            $state = if ($state -eq "healthy") { "resume-sent" } else { "$state-resume-sent" }
        }
    }
    elseif ($state -eq "healthy") {
        $state = "running-no-conversation-map"
    }
    else {
        $state = "$state-no-conversation-map"
    }

    Start-Sleep -Milliseconds 250
    [void](Set-WorkerWindowState -Runtime $Runtime -Mode minimize)
    $status = Get-WorkerStatusRow -Runtime $Runtime
    [pscustomobject]@{
        Worker = $Runtime.WorkerId
        Label = $Runtime.Label
        State = $state
        Running = $status.Running
        Responding = $status.Responding
        LoggedIn = $status.LoggedInState
        Automation = $status.Automation
        ConversationUrl = $url
    }
}

function Invoke-CdpHelper {
    param(
        [Parameter(Mandatory)]$Runtime,
        [Parameter(Mandatory)][string[]]$Arguments
    )
    if (-not (Test-TcpPort -Port $Runtime.DebugPort)) {
        throw "$($Runtime.WorkerId) automation port $($Runtime.DebugPort) is offline."
    }
    if (-not (Test-Path -LiteralPath $bootstrapScript)) {
        throw "CDP bootstrap helper is missing: $bootstrapScript"
    }
    $node = (Get-Command node -ErrorAction Stop).Source
    $commandArguments = @($bootstrapScript, "--port", [string]$Runtime.DebugPort, "--compact") + $Arguments
    $output = @(& $node @commandArguments)
    if ($LASTEXITCODE -ne 0) {
        throw "CDP helper failed for $($Runtime.WorkerId) with exit code $LASTEXITCODE."
    }
    $text = ($output -join "`n").Trim()
    try { return ($text | ConvertFrom-Json) }
    catch { throw "CDP helper returned invalid JSON for $($Runtime.WorkerId): $text" }
}

function Convert-ToCanonicalConversationUrl {
    param([string]$Url)
    if ([string]::IsNullOrWhiteSpace($Url)) { return $null }
    try { $uri = [Uri]$Url }
    catch { return $null }
    if ($uri.Scheme -ne "https" -or $uri.Host -ne "chatgpt.com") { return $null }
    $match = [regex]::Match($uri.AbsolutePath, '^/(?:c|g/g-p-[^/]+/c)/([A-Za-z0-9_-]{16,})/?$')
    if (-not $match.Success) { return $null }
    $conversationId = $match.Groups[1].Value
    if ($conversationId -match '^(?:WEB|TEMP|LOCAL)[_:.-]' -or $conversationId.Contains(':')) { return $null }
    return "$($uri.Scheme)://$($uri.Host)$($uri.AbsolutePath.TrimEnd('/'))"
}

function Invoke-AutoJoin {
    param([Parameter(Mandatory)]$Runtime)
    Assert-WorkerMutable -Runtime $Runtime -Operation "autojoin"

    if ([string]::IsNullOrWhiteSpace($InviteCode)) {
        throw "autojoin requires -InviteCode."
    }
    if (-not (Test-WorkerSignedIn -Runtime $Runtime)) { [void](Ensure-WorkerAuthenticated -Runtime $Runtime) }
    $arguments = @("--invite", $InviteCode, "--label", $Runtime.Label, "--minimal")
    $existingConversationUrl = Get-WorkerConversationUrl -Runtime $Runtime
    if ($existingConversationUrl) {
        $arguments += @("--conversation-url", $existingConversationUrl)
    }
    else {
        $targetProjectUrl = Get-ConfiguredProjectUrl
        if ($targetProjectUrl) { $arguments += @("--project-url", $targetProjectUrl) }
    }
    $result = Invoke-CdpHelper -Runtime $Runtime -Arguments $arguments
    $url = Convert-ToCanonicalConversationUrl -Url ([string]$result.conversationUrl)
    if (-not $url) { $url = Convert-ToCanonicalConversationUrl -Url ([string]$result.after.href) }
    if (-not $url) { throw "$($Runtime.WorkerId) bootstrap sent but no stable server conversation URL was returned; refusing to persist a transient route." }
    Set-WorkerConversationUrl -Runtime $Runtime -Url $url
    return $result
}

$runtimes = @(Get-WorkerNumberRange | ForEach-Object { Get-WorkerRuntime -Number $_ })

switch ($Action) {
    "setup" {
        Ensure-RuntimeIdentityTasks
        if (-not (Test-Path -LiteralPath $runtimeCloneScript)) {
            throw "Runtime clone helper is missing: $runtimeCloneScript"
        }
        foreach ($runtime in $runtimes) { Assert-WorkerMutable -Runtime $runtime -Operation "setup/re-register" }
        & $runtimeCloneScript -Count $Count -FirstWorker $FirstWorker -ForceRefresh:$ForceRefresh
        $runtimes = @(Get-WorkerNumberRange | ForEach-Object { Get-WorkerRuntime -Number $_ })
        Save-ControllerState -Runtimes $runtimes
        $runtimes | ForEach-Object { Get-WorkerStatusRow -Runtime $_ } | Format-Table -AutoSize
    }
    "start" {
        Ensure-RuntimeIdentityTasks
        Save-ControllerState -Runtimes $runtimes
        $started = foreach ($runtime in $runtimes) {
            Assert-WorkerMutable -Runtime $runtime -Operation "start"
            Start-WorkerRuntime -Runtime $runtime -Automation:$EnableAutomation -ForceRestart:$RestartForAutomation
        }
        if (-not $NoMinimize) {
            Start-Sleep -Seconds 1
            foreach ($runtime in $runtimes) { [void](Set-WorkerWindowState -Runtime $runtime -Mode minimize) }
        }
        $started | Format-Table -AutoSize
    }
    "plan" {
        $targetNumbers = @(Get-ProductionWorkerNumbers -Desired $DesiredWorkers)
        [pscustomobject]@{
            Ok = $true
            DesiredWorkers = $DesiredWorkers
            ProductionWorkerNumbers = $targetNumbers
            ReservedWorkers = @(Get-ReservedWorkerNumbers)
            ProtectedWorkers = @(Get-ProtectedWorkerNumbers)
        } | ConvertTo-Json -Depth 5
    }
    "scale" {
        Ensure-RuntimeIdentityTasks
        $targetNumbers = @(Get-ProductionWorkerNumbers -Desired $DesiredWorkers)
        $targetSet = [System.Collections.Generic.HashSet[int]]::new()
        foreach ($number in $targetNumbers) { [void]$targetSet.Add([int]$number) }

        $existingTargets = @($targetNumbers | ForEach-Object { Get-WorkerRuntime -Number $_ })
        $missing = @($existingTargets | Where-Object { -not $_.Registered })
        foreach ($runtime in $missing) {
            & $runtimeCloneScript -Count 1 -FirstWorker $runtime.Number
        }
        $targetRuntimes = @($targetNumbers | ForEach-Object { Get-WorkerRuntime -Number $_ })

        Save-ControllerState -Runtimes $targetRuntimes
        Set-ProductionDesired -Desired $DesiredWorkers

        $rows = @()
        foreach ($runtime in $targetRuntimes) { $rows += Ensure-OneRuntime -Runtime $runtime }

        $reserved = @((Get-ReservedWorkerNumbers) + (Get-ProtectedWorkerNumbers) | Sort-Object -Unique)
        for ($number = 1; $number -le 32; $number++) {
            if ($reserved -contains $number -or $targetSet.Contains($number)) { continue }
            $runtime = Get-WorkerRuntime -Number $number
            if (-not $runtime.Registered) { continue }
            if (Get-WorkerRootProcess -Runtime $runtime) {
                Stop-WorkerRuntime -Runtime $runtime
                $rows += [pscustomobject]@{
                    Worker = $runtime.WorkerId
                    Label = $runtime.Label
                    State = "scaled-down-stopped"
                    Running = $false
                    Responding = $false
                    LoggedIn = $null
                    Automation = $false
                    ConversationUrl = (Get-WorkerConversationUrl -Runtime $runtime)
                }
            }
        }
        $rows | Format-Table -AutoSize
    }
    "ensure" {
        Save-ControllerState -Runtimes $runtimes
        $rows = foreach ($runtime in $runtimes) { Ensure-OneRuntime -Runtime $runtime }
        $rows | Format-Table -AutoSize
    }
    "status" {
        $runtimes | ForEach-Object { Get-WorkerStatusRow -Runtime $_ } | Format-Table -AutoSize
    }
    "minimize" {
        $rows = foreach ($runtime in $runtimes) {
            [pscustomobject]@{ Worker = $runtime.WorkerId; Minimized = [bool](Set-WorkerWindowState -Runtime $runtime -Mode minimize) }
        }
        $rows | Format-Table -AutoSize
    }
    "restore" {
        $runtime = Get-WorkerRuntime -Number $Worker
        [pscustomobject]@{ Worker = $runtime.WorkerId; Restored = [bool](Set-WorkerWindowState -Runtime $runtime -Mode restore) } | Format-List
    }
    "stop" {
        foreach ($runtime in $runtimes) { Stop-WorkerRuntime -Runtime $runtime }
        Start-Sleep -Milliseconds 600
        $runtimes | ForEach-Object { Get-WorkerStatusRow -Runtime $_ } | Format-Table -AutoSize
    }
    "repair" {
        $runtime = Get-WorkerRuntime -Number $Worker
        if (-not $runtime.Registered) {
            throw "$($runtime.WorkerId) is not registered. Use setup instead."
        }
        Stop-WorkerRuntime -Runtime $runtime
        Start-Sleep -Milliseconds 700
        Start-WorkerRuntime -Runtime $runtime -Automation:$EnableAutomation -ForceRestart | Format-List
    }
    "capture" {
        Save-ControllerState -Runtimes $runtimes
        $rows = foreach ($runtime in $runtimes) {
            try {
                $probeResult = Invoke-CdpHelper -Runtime $runtime -Arguments @("--probe")
                $url = Convert-ToCanonicalConversationUrl -Url ([string]$probeResult.probe.href)
                if (-not $url) { throw "Current page is not a ChatGPT conversation." }
                Set-WorkerConversationUrl -Runtime $runtime -Url $url
                [pscustomobject]@{ Worker = $runtime.WorkerId; State = "captured"; ConversationUrl = $url }
            }
            catch {
                [pscustomobject]@{ Worker = $runtime.WorkerId; State = "capture-failed"; ConversationUrl = $_.Exception.Message }
            }
        }
        $rows | Format-Table -AutoSize
    }
    "recover" {
        $runtime = Get-WorkerRuntime -Number $Worker
        Save-ControllerState -Runtimes @($runtime)
        $url = Get-WorkerConversationUrl -Runtime $runtime
        if (-not $url) { throw "No saved conversation URL for $($runtime.WorkerId). Run capture after a successful join first." }

        Stop-WorkerRuntime -Runtime $runtime
        Start-Sleep -Milliseconds 700
        $started = Start-WorkerRuntime -Runtime $runtime -Automation -ForceRestart
        $cleanup = Invoke-CdpHelper -Runtime $runtime -Arguments @("--dismiss-only", "--label", $runtime.Label, "--conversation-url", $url)
        $probe = $cleanup.afterDismiss
        $recoveryState = "restored-active"
        if ($probe.connectionInterrupted) {
            $null = Invoke-CdpHelper -Runtime $runtime -Arguments @("--interrupt-only", "--label", $runtime.Label, "--conversation-url", $url)
            Start-Sleep -Milliseconds 500
            $null = Invoke-CdpHelper -Runtime $runtime -Arguments @("--resume", "--label", $runtime.Label, "--conversation-url", $url)
            $recoveryState = "interrupted-resume-sent"
        }
        elseif (-not $probe.generating) {
            $null = Invoke-CdpHelper -Runtime $runtime -Arguments @("--resume", "--label", $runtime.Label, "--conversation-url", $url)
            $recoveryState = "resume-sent"
        }
        Start-Sleep -Milliseconds 500
        [void](Set-WorkerWindowState -Runtime $runtime -Mode minimize)
        [pscustomobject]@{
            Worker = $runtime.WorkerId
            State = $recoveryState
            Pid = $started.Pid
            ConversationUrl = $url
            WasGenerating = [bool]$probe.generating
            ConnectionInterrupted = [bool]$probe.connectionInterrupted
        } | Format-List
    }
    "autojoin" {
        Save-ControllerState -Runtimes $runtimes
        $rows = for ($index = 0; $index -lt $runtimes.Count; $index++) {
            $runtime = $runtimes[$index]
            try {
                $null = Invoke-AutoJoin -Runtime $runtime
                [pscustomobject]@{ Worker = $runtime.WorkerId; State = "bootstrap-sent"; Detail = "ok" }
            }
            catch {
                [pscustomobject]@{ Worker = $runtime.WorkerId; State = "deferred"; Detail = $_.Exception.Message }
            }
            if ($StaggerSeconds -gt 0 -and $index -lt ($runtimes.Count - 1)) {
                Start-Sleep -Seconds $StaggerSeconds
            }
        }
        $rows | Format-Table -AutoSize
    }
    "protect" {
        $runtime = Get-WorkerRuntime -Number $Worker
        Save-ControllerState -Runtimes @($runtime)
        Set-WorkerProtection -Runtime $runtime -Enabled $true -Reason $ProtectionReason | Format-List
    }
    "unprotect" {
        $runtime = Get-WorkerRuntime -Number $Worker
        Set-WorkerProtection -Runtime $runtime -Enabled $false | Format-List
    }
    "help" {
        @"
Chat Swarm Classic Controller

  setup     Create/register missing worker runtime clones.
  start     Start workers; minimizes them by default.
  ensure    Make the saved worker pool healthy: start/reopen exact conversations, resume interrupted loops, minimize.
  status    Show runtime/login/automation health.
  minimize Minimize selected worker range.
  restore   Restore one worker window (-Worker N).
  stop      Stop only isolated worker runtimes; primary ChatGPT is untouched.
  repair    Restart one isolated worker without deleting its profile.
  capture   Persist each worker's current ChatGPT conversation URL for recovery.
  recover   Restart one worker, reopen its saved conversation, dismiss blockers, and resume only if needed.
  autojoin  Inject the current swarm join/bootstrap prompt via local CDP and save its conversation URL.

Automation example:
  .\chat-swarm-classic-controller.ps1 -Action start -Count 4 -EnableAutomation -RestartForAutomation
  .\chat-swarm-classic-controller.ps1 -Action autojoin -Count 4 -InviteCode ABCDEF123456
"@ | Write-Output
    }
}
