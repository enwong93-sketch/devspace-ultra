[CmdletBinding()]
param(
    [ValidateRange(2, 32)]
    [int]$MainNumber = 2,

    [ValidateRange(30, 300)]
    [int]$WaitSeconds = 150,

    [ValidateSet("start", "finish", "full")]
    [string]$Stage = "full"
)

$ErrorActionPreference = "Stop"
$relayScript = Join-Path $PSScriptRoot "chat-classic-interactive-auth-relay.ps1"
$bootstrapScript = Join-Path $PSScriptRoot "chat-swarm-classic-cdp-bootstrap.mjs"
$interactiveStateRoot = Join-Path $env:LOCALAPPDATA "DevSpace\ChatGPTInteractive"
$debugBasePort = 9730

function Get-RootProcessForExecutable {
    param([Parameter(Mandatory)][string]$ExecutablePath)
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -eq "ChatGPT Classic.exe" -and
            $_.ExecutablePath -eq $ExecutablePath -and
            $_.CommandLine -notlike "*--type=*"
        } |
        Sort-Object CreationDate |
        Select-Object -First 1
}

function Get-PrimarySnapshot {
    $package = Get-AppxPackage -Name "OpenAI.ChatGPT-Desktop" -ErrorAction Stop |
        Sort-Object Version -Descending |
        Select-Object -First 1
    $exe = Join-Path $package.InstallLocation "app\ChatGPT Classic.exe"
    $root = Get-RootProcessForExecutable -ExecutablePath $exe
    $process = if ($root) { Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue } else { $null }
    [pscustomobject]@{
        PackageName = $package.Name
        PackageFamilyName = $package.PackageFamilyName
        Version = [string]$package.Version
        Pid = if ($root) { [int]$root.ProcessId } else { $null }
        Visible = [bool]($process -and $process.MainWindowHandle -ne 0)
        WindowHandle = if ($process) { [long]$process.MainWindowHandle } else { 0 }
    }
}

function Get-InteractiveSnapshot {
    param([Parameter(Mandatory)][int]$Number)
    $padded = "{0:D2}" -f $Number
    $package = Get-AppxPackage -Name "OpenAI.ChatGPT-Desktop.Interactive$padded" -ErrorAction Stop |
        Sort-Object Version -Descending |
        Select-Object -First 1
    $exe = Join-Path $package.InstallLocation "app\ChatGPT Classic.exe"
    $root = Get-RootProcessForExecutable -ExecutablePath $exe
    $process = if ($root) { Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue } else { $null }
    [pscustomobject]@{
        Number = $Number
        RuntimeId = "interactive-$padded"
        Label = "Main-$padded"
        PackageName = $package.Name
        PackageFamilyName = $package.PackageFamilyName
        Pid = if ($root) { [int]$root.ProcessId } else { $null }
        Visible = [bool]($process -and $process.MainWindowHandle -ne 0)
        WindowHandle = if ($process) { [long]$process.MainWindowHandle } else { 0 }
        AliasPath = Join-Path $env:LOCALAPPDATA ("Microsoft\WindowsApps\chatgpt-classic-main$padded.exe")
        DebugPort = $debugBasePort + $Number
    }
}

function Invoke-Probe {
    param(
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][string]$Node
    )
    $output = @(& $Node $bootstrapScript --port $Port --probe --compact)
    if ($LASTEXITCODE -ne 0) { throw "Interactive CDP probe failed." }
    try { return (($output -join "`n") | ConvertFrom-Json).probe }
    catch { throw "Interactive CDP probe returned invalid JSON." }
}

function Ensure-OAuthProvisionMarker {
    param(
        [Parameter(Mandatory)]$Runtime,
        [Parameter(Mandatory)]$Primary
    )
    $path = Join-Path $interactiveStateRoot ($Runtime.RuntimeId + ".json")
    if (Test-Path -LiteralPath $path) { return }
    New-Item -ItemType Directory -Path $interactiveStateRoot -Force | Out-Null
    [ordered]@{
        version = 2
        runtimeId = $Runtime.RuntimeId
        label = $Runtime.Label
        packageName = $Runtime.PackageName
        packageFamilyName = $Runtime.PackageFamilyName
        sourcePrimaryPackage = $Primary.PackageName
        sourcePrimaryVersion = $Primary.Version
        provisioningMode = "oauth-relay"
        provisionedAt = (Get-Date).ToString("o")
        authValuesPersistedByDevSpace = $false
        independentProfile = $true
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $path -Encoding UTF8
}

function Invoke-GoogleLoginClick {
    param(
        [Parameter(Mandatory)]$Runtime,
        [Parameter(Mandatory)][string]$Node
    )
    $googleOutput = @(& $Node $bootstrapScript --port $Runtime.DebugPort --google-login-only --compact)
    if ($LASTEXITCODE -ne 0) { throw "$($Runtime.Label) Google login control was not clickable." }
    try { $googleClick = ($googleOutput -join "`n") | ConvertFrom-Json }
    catch { throw "$($Runtime.Label) Google login click returned invalid JSON." }
    if (-not $googleClick.ok -or -not $googleClick.googleLogin.clicked) { throw "$($Runtime.Label) Google login control was not clicked." }
    return $googleClick
}

if (-not (Test-Path -LiteralPath $relayScript)) { throw "Interactive auth relay helper is missing." }
if (-not (Test-Path -LiteralPath $bootstrapScript)) { throw "Interactive CDP helper is missing." }
$node = (Get-Command node -ErrorAction Stop).Source

$primaryBefore = Get-PrimarySnapshot
if (-not $primaryBefore.Pid -or -not $primaryBefore.Visible) {
    throw "Main-01 must already be running and visible; the auth live gate will not start or restart it."
}
$runtime = Get-InteractiveSnapshot -Number $MainNumber
if (-not $runtime.Pid -or -not $runtime.Visible) {
    throw "$($runtime.Label) must already be running and visible."
}
if (-not (Test-Path -LiteralPath $runtime.AliasPath)) {
    throw "$($runtime.Label) explicit launcher alias is missing."
}

$beforeProbe = Invoke-Probe -Port $runtime.DebugPort -Node $node
if ($beforeProbe.composer -and -not $beforeProbe.loginVisible) {
    Ensure-OAuthProvisionMarker -Runtime $runtime -Primary $primaryBefore
    [pscustomobject]@{
        Ok = $true
        State = "already-signed-in"
        Label = $runtime.Label
        SessionVerified = $true
        Relayed = $false
        Main01Unchanged = $true
        PrimaryPidBefore = $primaryBefore.Pid
        PrimaryPidAfter = $primaryBefore.Pid
        PrimaryWindowBefore = $primaryBefore.WindowHandle
        PrimaryWindowAfter = $primaryBefore.WindowHandle
        SecretMaterialLogged = $false
    } | ConvertTo-Json -Depth 4 -Compress
    exit 0
}

if ($Stage -ne "finish") {
    if ([string]$beforeProbe.href -match '/auth/error') {
        $backOutput = @(& $node $bootstrapScript --port $runtime.DebugPort --auth-back-only --compact)
        if ($LASTEXITCODE -ne 0) { throw "$($runtime.Label) OAuth error recovery control was not clickable." }
        try { $back = ($backOutput -join "`n") | ConvertFrom-Json }
        catch { throw "$($runtime.Label) OAuth error recovery returned invalid JSON." }
        if (-not $back.ok -or -not $back.authBack.clicked) { throw "$($runtime.Label) OAuth error recovery did not click Back." }
        Start-Sleep -Milliseconds 900
        $beforeProbe = Invoke-Probe -Port $runtime.DebugPort -Node $node
    }

    if ([string]$beforeProbe.href -notmatch '/auth/login' -and $beforeProbe.loginVisible) {
        $loginOutput = @(& $node $bootstrapScript --port $runtime.DebugPort --login-only --compact)
        if ($LASTEXITCODE -ne 0) { throw "$($runtime.Label) login control was not clickable." }
        try { $loginClick = ($loginOutput -join "`n") | ConvertFrom-Json }
        catch { throw "$($runtime.Label) login click returned invalid JSON." }
        if (-not $loginClick.ok -or -not $loginClick.login.clicked) { throw "$($runtime.Label) login control was not clicked." }
        Start-Sleep -Milliseconds 700
    }
}

if ($Stage -eq "start") {
    [void](Invoke-GoogleLoginClick -Runtime $runtime -Node $node)
    $primaryAfter = Get-PrimarySnapshot
    $main01Unchanged = [bool](
        $primaryAfter.Pid -eq $primaryBefore.Pid -and
        $primaryAfter.WindowHandle -eq $primaryBefore.WindowHandle -and
        $primaryAfter.Visible
    )
    if (-not $main01Unchanged) { throw "Main-01 PID/window changed while starting Interactive authentication." }
    [pscustomobject]@{
        Ok = $true
        State = "browser-auth-started"
        Stage = "start"
        Label = $runtime.Label
        SessionVerified = $false
        AuthRequired = $true
        Relayed = $false
        Main01Unchanged = $true
        PrimaryPidBefore = $primaryBefore.Pid
        PrimaryPidAfter = $primaryAfter.Pid
        PrimaryWindowBefore = $primaryBefore.WindowHandle
        PrimaryWindowAfter = $primaryAfter.WindowHandle
        SecretMaterialLogged = $false
        WindowsDefaultChanged = $false
    } | ConvertTo-Json -Depth 4 -Compress
    exit 0
}

$job = Start-Job -ArgumentList $relayScript, $runtime.AliasPath, $WaitSeconds -ScriptBlock {
    param($RelayScript, $TargetAlias, $TimeoutSeconds)
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $RelayScript -TargetAlias $TargetAlias -WaitSeconds $TimeoutSeconds -PollMilliseconds 100
}

try {
    if ($Stage -eq "full") {
        Start-Sleep -Milliseconds 500
        [void](Invoke-GoogleLoginClick -Runtime $runtime -Node $node)
    }

    $null = Wait-Job -Job $job -Timeout ($WaitSeconds + 10)
    if ($job.State -ne "Completed") {
        throw "Interactive auth relay did not complete before timeout."
    }
    $relayText = (@(Receive-Job -Job $job -ErrorAction Stop) -join "`n").Trim()
    try { $relay = $relayText | ConvertFrom-Json }
    catch { throw "Interactive auth relay returned invalid status output." }
    if (-not $relay.Ok -or -not $relay.Relayed) {
        throw "Interactive auth relay did not forward the desktop callback."
    }

    $deadline = (Get-Date).AddSeconds(45)
    $probe = $null
    do {
        Start-Sleep -Milliseconds 750
        $probe = Invoke-Probe -Port $runtime.DebugPort -Node $node
        if ($probe.composer -and -not $probe.loginVisible) { break }
    } while ((Get-Date) -lt $deadline)

    $sessionVerified = [bool]($probe -and $probe.composer -and -not $probe.loginVisible)
    if (-not $sessionVerified) { throw "$($runtime.Label) received the callback but did not verify as signed in." }
    $runtimeAfter = Get-InteractiveSnapshot -Number $MainNumber
    Ensure-OAuthProvisionMarker -Runtime $runtimeAfter -Primary $primaryBefore

    $primaryAfter = Get-PrimarySnapshot
    $main01Unchanged = [bool](
        $primaryAfter.Pid -eq $primaryBefore.Pid -and
        $primaryAfter.WindowHandle -eq $primaryBefore.WindowHandle -and
        $primaryAfter.Visible
    )
    if (-not $main01Unchanged) {
        throw "Main-01 PID/window changed during Interactive auth relay."
    }

    [pscustomobject]@{
        Ok = $true
        State = "interactive-auth-relay-pass"
        Label = $runtimeAfter.Label
        SessionVerified = $sessionVerified
        Relayed = $true
        Main02Pid = $runtimeAfter.Pid
        Main02WindowHandle = $runtimeAfter.WindowHandle
        Main01Unchanged = $main01Unchanged
        PrimaryPidBefore = $primaryBefore.Pid
        PrimaryPidAfter = $primaryAfter.Pid
        PrimaryWindowBefore = $primaryBefore.WindowHandle
        PrimaryWindowAfter = $primaryAfter.WindowHandle
        SecretMaterialLogged = $false
        WindowsDefaultChanged = $false
    } | ConvertTo-Json -Depth 4 -Compress
}
finally {
    if ($job) {
        Stop-Job -Job $job -ErrorAction SilentlyContinue | Out-Null
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
}
