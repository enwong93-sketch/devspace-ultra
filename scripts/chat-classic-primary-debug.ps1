[CmdletBinding()]
param(
    [ValidateSet("status", "repair", "show")]
    [string]$Action = "status",

    [int]$ExpectedPid = 0,

    [ValidateRange(10, 90)]
    [int]$VerifyTimeoutSeconds = 45
)

$ErrorActionPreference = "Stop"
$primaryDebugPort = 9721
$primaryAlias = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\chatgpt-classic.exe"

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

function Get-CanonicalPrimary {
    $package = Get-AppxPackage -Name "OpenAI.ChatGPT-Desktop" -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if (-not $package) { throw "canonical-primary-package-missing" }
    $exe = Join-Path $package.InstallLocation "app\ChatGPT Classic.exe"
    $root = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -eq "ChatGPT Classic.exe" -and
            $_.ExecutablePath -eq $exe -and
            $_.CommandLine -notlike "*--type=*"
        } |
        Sort-Object CreationDate |
        Select-Object -First 1
    $process = if ($root) { Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue } else { $null }
    $startedAt = if ($root -and $root.CreationDate) {
        try { ([datetime]$root.CreationDate).ToUniversalTime().ToString("o") } catch { $null }
    } else { $null }
    [pscustomobject]@{
        PackageName = $package.Name
        PackageFamilyName = $package.PackageFamilyName
        ExecutablePath = $exe
        Running = [bool]$root
        Pid = if ($root) { [int]$root.ProcessId } else { $null }
        Visible = [bool]($process -and $process.MainWindowHandle -ne 0)
        WindowHandle = if ($process) { [long]$process.MainWindowHandle } else { 0 }
        StartedAt = $startedAt
        DebugReady = [bool](Test-TcpPort -Port $primaryDebugPort)
        DebugPort = $primaryDebugPort
    }
}

function Stop-CanonicalPrimary {
    param([Parameter(Mandatory)]$Primary)
    $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -eq "ChatGPT Classic.exe" -and $_.ExecutablePath -eq $Primary.ExecutablePath
    })
    foreach ($process in $processes) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    $deadline = (Get-Date).AddSeconds(15)
    do {
        $remaining = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -eq "ChatGPT Classic.exe" -and $_.ExecutablePath -eq $Primary.ExecutablePath
        })
        if ($remaining.Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw "canonical-primary-stop-timeout"
}

function Start-CanonicalPrimaryDebug {
    param([Parameter(Mandatory)]$Primary)
    $args = @(
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=$primaryDebugPort"
    )
    try {
        Start-Process -FilePath $Primary.ExecutablePath -ArgumentList $args | Out-Null
    }
    catch {
        if (-not (Test-Path -LiteralPath $primaryAlias)) { throw }
        Start-Process -FilePath $primaryAlias -ArgumentList $args | Out-Null
    }

    $deadline = (Get-Date).AddSeconds($VerifyTimeoutSeconds)
    do {
        Start-Sleep -Milliseconds 300
        $current = Get-CanonicalPrimary
        if ($current.Running -and $current.Visible -and $current.DebugReady) { return $current }
    } while ((Get-Date) -lt $deadline)
    throw "canonical-primary-debug-verify-timeout"
}

function Restore-CanonicalPrimaryNormal {
    if (Test-Path -LiteralPath $primaryAlias) {
        try { Start-Process -FilePath $primaryAlias | Out-Null } catch {}
    }
}

function Show-CanonicalPrimary {
    param([Parameter(Mandatory)]$Primary)
    if ($Primary.Visible) { return $Primary }
    if (-not (Test-Path -LiteralPath $primaryAlias)) { throw "canonical-primary-alias-missing" }
    # Acceptance-only activation: ask the canonical registered app to surface its
    # existing single-instance window. Do not stop the process, alter protocol
    # ownership, or touch the current conversation URL.
    Start-Process -FilePath $primaryAlias | Out-Null
    $deadline = (Get-Date).AddSeconds($VerifyTimeoutSeconds)
    do {
        Start-Sleep -Milliseconds 300
        $current = Get-CanonicalPrimary
        if ($current.Running -and $current.Visible) { return $current }
    } while ((Get-Date) -lt $deadline)
    throw "canonical-primary-show-timeout"
}

if ($Action -eq "status") {
    $state = Get-CanonicalPrimary
    $state | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

if ($Action -eq "show") {
    $beforeShow = Get-CanonicalPrimary
    $afterShow = Show-CanonicalPrimary -Primary $beforeShow
    [pscustomobject]@{
        Ok = [bool]($afterShow.Running -and $afterShow.Visible)
        State = "primary-shown"
        Pid = $afterShow.Pid
        DebugReady = $afterShow.DebugReady
        Visible = $afterShow.Visible
        PrimaryPidBefore = $beforeShow.Pid
        PrimaryPidAfter = $afterShow.Pid
        CanonicalPackagePreserved = $true
        ProtocolOwnerModified = $false
    } | ConvertTo-Json -Depth 4 -Compress
    exit 0
}

$before = Get-CanonicalPrimary
if (-not $before.Running -or -not $before.Pid) {
    [pscustomobject]@{
        Ok = $false
        State = "primary-absent"
        Reason = "canonical-primary-not-running"
        DefiniteFailure = $true
        Pid = $null
        DebugReady = $false
        Visible = $false
    } | ConvertTo-Json -Depth 4 -Compress
    exit 1
}
if ($ExpectedPid -gt 0 -and $before.Pid -ne $ExpectedPid) {
    [pscustomobject]@{
        Ok = $false
        State = "pid-race"
        Reason = "canonical-primary-pid-changed"
        DefiniteFailure = $true
        Pid = $before.Pid
        DebugReady = $before.DebugReady
        Visible = $before.Visible
    } | ConvertTo-Json -Depth 4 -Compress
    exit 1
}
if ($before.DebugReady) {
    [pscustomobject]@{
        Ok = $true
        State = "already-debug-ready"
        Pid = $before.Pid
        DebugReady = $true
        Visible = $before.Visible
        PrimaryPidBefore = $before.Pid
        PrimaryPidAfter = $before.Pid
        CanonicalPackagePreserved = $true
        ProtocolOwnerModified = $false
    } | ConvertTo-Json -Depth 4 -Compress
    exit 0
}

$stopped = $false
$after = $null
$reason = $null
try {
    Stop-CanonicalPrimary -Primary $before
    $stopped = $true
    $after = Start-CanonicalPrimaryDebug -Primary $before
}
catch {
    $reason = if ($_.Exception.Message -match '^[a-z0-9-]+$') { $_.Exception.Message } else { "unexpected-primary-debug-error" }
    if ($stopped) { Restore-CanonicalPrimaryNormal }
}

$ok = [bool]($after -and $after.Running -and $after.Visible -and $after.DebugReady)
[pscustomobject]@{
    Ok = $ok
    State = if ($ok) { "primary-debug-repaired" } else { "primary-debug-repair-failed" }
    Reason = $reason
    DefiniteFailure = [bool](-not $ok)
    Pid = if ($after) { $after.Pid } else { $null }
    DebugReady = [bool]($after -and $after.DebugReady)
    Visible = [bool]($after -and $after.Visible)
    PrimaryPidBefore = $before.Pid
    PrimaryPidAfter = if ($after) { $after.Pid } else { $null }
    CanonicalPackagePreserved = $true
    ProtocolOwnerModified = $false
} | ConvertTo-Json -Depth 5 -Compress
if (-not $ok) { exit 1 }
