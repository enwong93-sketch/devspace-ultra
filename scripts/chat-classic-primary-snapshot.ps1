[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$TargetProfile,

    [ValidateRange(10, 90)]
    [int]$VerifyTimeoutSeconds = 45
)

$ErrorActionPreference = "Stop"
$authSeedScript = Join-Path $PSScriptRoot "chat-swarm-classic-auth-seed.mjs"
$bootstrapScript = Join-Path $PSScriptRoot "chat-swarm-classic-cdp-bootstrap.mjs"
$primaryDebugPort = 9721

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
    [pscustomobject]@{
        PackageName = $package.Name
        PackageFamilyName = $package.PackageFamilyName
        AppUserModelId = "$($package.PackageFamilyName)!ChatGPT"
        ExecutablePath = $exe
        ProfilePath = Join-Path $env:LOCALAPPDATA ("Packages\{0}\LocalCache\Roaming\ChatGPT" -f $package.PackageFamilyName)
        Running = [bool]$root
        Pid = if ($root) { [int]$root.ProcessId } else { $null }
        Visible = [bool]($process -and $process.MainWindowHandle -ne 0)
        WindowHandle = if ($process) { [long]$process.MainWindowHandle } else { 0 }
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

function Test-CanonicalPrimarySignedIn {
    if (-not (Test-TcpPort -Port $primaryDebugPort)) { return $false }
    $node = (Get-Command node -ErrorAction Stop).Source
    try {
        $output = @(& $node $bootstrapScript --port $primaryDebugPort --probe --compact 2>$null)
        if ($LASTEXITCODE -ne 0) { return $false }
        $probe = (($output -join "`n").Trim() | ConvertFrom-Json).probe
        return [bool]($probe -and $probe.composer -and -not $probe.composerDisabled -and -not $probe.loginVisible -and -not $probe.accountExpired)
    }
    catch { return $false }
}

function Start-AndVerifyCanonicalPrimary {
    param([Parameter(Mandatory)]$Primary)
    $args = @(
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=$primaryDebugPort"
    )
    Start-Process -FilePath $Primary.ExecutablePath -ArgumentList $args | Out-Null
    $deadline = (Get-Date).AddSeconds($VerifyTimeoutSeconds)
    do {
        $current = Get-CanonicalPrimary
        if ($current.Running -and $current.Visible -and (Test-CanonicalPrimarySignedIn)) {
            return $current
        }
        Start-Sleep -Milliseconds 350
    } while ((Get-Date) -lt $deadline)
    throw "canonical-primary-restore-verification-failed"
}

$before = Get-CanonicalPrimary
if (-not $before.Running -or -not $before.Visible) {
    throw "canonical-primary-must-start-visible"
}
if (-not (Test-Path -LiteralPath $before.ProfilePath)) {
    throw "canonical-primary-profile-missing"
}
if (-not (Test-Path -LiteralPath $authSeedScript)) {
    throw "profile-seed-helper-missing"
}

$stopped = $false
$seedOk = $false
$restored = $false
$after = $null
$stage = "prepare"
$reason = $null

try {
    $stage = "stop-primary"
    Stop-CanonicalPrimary -Primary $before
    $stopped = $true

    $stage = "snapshot"
    $node = (Get-Command node -ErrorAction Stop).Source
    $seedOutput = @(& $node $authSeedScript --source-profile $before.ProfilePath --target-profile $TargetProfile)
    $seedExit = if ($null -eq $LASTEXITCODE) { 1 } else { [int]$LASTEXITCODE }
    $seedText = ($seedOutput -join "`n").Trim()
    try { $seed = $seedText | ConvertFrom-Json }
    catch { throw "profile-seed-invalid-json" }
    if ($seed.secretValuesLogged) { throw "profile-seed-secret-output-refused" }
    if ($seedExit -ne 0 -or -not $seed.ok) { throw "profile-seed-failed" }
    $seedOk = $true

    $stage = "restore-primary"
    $after = Start-AndVerifyCanonicalPrimary -Primary $before
    $restored = $true
}
catch {
    $reason = if ($_.Exception.Message -match '^[a-z0-9-]+$') { $_.Exception.Message } else { "unexpected" }
    if ($stopped -and -not $restored) {
        try {
            $after = Start-AndVerifyCanonicalPrimary -Primary $before
            $restored = $true
        }
        catch {
            $restored = $false
        }
    }
}

$result = [ordered]@{
    Ok = [bool]($seedOk -and $restored)
    State = if ($seedOk -and $restored) { "primary-controlled-snapshot" } else { "primary-controlled-snapshot-failed" }
    Stage = $stage
    Reason = $reason
    PrimaryRestarted = $stopped
    PrimaryRestored = $restored
    PrimaryPidBefore = $before.Pid
    PrimaryPidAfter = if ($after) { $after.Pid } else { $null }
    PrimaryWindowBefore = $before.WindowHandle
    PrimaryWindowAfter = if ($after) { $after.WindowHandle } else { 0 }
    SessionSeeded = $seedOk
    AuthValuesPersistedByDevSpace = $false
    SecretValuesLogged = $false
}
$result | ConvertTo-Json -Depth 6 -Compress
if (-not $result.Ok) { exit 1 }
