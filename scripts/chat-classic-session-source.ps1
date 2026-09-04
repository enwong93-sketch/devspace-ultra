[CmdletBinding()]
param(
    [ValidateRange(2, 32)]
    [int]$TargetMainNumber = 2,

    [ValidateRange(3, 30)]
    [int]$ProbeTimeoutSeconds = 8
)

$ErrorActionPreference = "Stop"
$bootstrapScript = Join-Path $PSScriptRoot "chat-swarm-classic-cdp-bootstrap.mjs"
$interactiveDebugBasePort = 9730
$workerDebugBasePort = 9330

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

function Get-RootProcessForExecutable {
    param([string]$ExecutablePath)
    if ([string]::IsNullOrWhiteSpace($ExecutablePath)) { return $null }
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -eq "ChatGPT Classic.exe" -and
            $_.ExecutablePath -eq $ExecutablePath -and
            $_.CommandLine -notlike "*--type=*"
        } |
        Sort-Object CreationDate |
        Select-Object -First 1
}

function Test-SignedInPort {
    param([Parameter(Mandatory)][int]$Port)
    if (-not (Test-TcpPort -Port $Port)) { return $false }
    if (-not (Test-Path -LiteralPath $bootstrapScript)) { return $false }
    $node = (Get-Command node -ErrorAction Stop).Source
    try {
        $output = @(& $node $bootstrapScript --port $Port --probe --compact 2>$null)
        if ($LASTEXITCODE -ne 0) { return $false }
        $payload = ($output -join "`n").Trim() | ConvertFrom-Json
        $probe = $payload.probe
        return [bool]($probe -and $probe.composer -and -not $probe.composerDisabled -and -not $probe.loginVisible -and -not $probe.accountExpired)
    }
    catch { return $false }
}

function Get-InteractiveCandidate {
    param([Parameter(Mandatory)][int]$Number)
    $padded = "{0:D2}" -f $Number
    $package = Get-AppxPackage -Name "OpenAI.ChatGPT-Desktop.Interactive$padded" -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if (-not $package) { return $null }
    $exe = Join-Path $package.InstallLocation "app\ChatGPT Classic.exe"
    $root = Get-RootProcessForExecutable -ExecutablePath $exe
    $port = $interactiveDebugBasePort + $Number
    if (-not $root -or -not (Test-SignedInPort -Port $port)) { return $null }
    [pscustomobject]@{
        Priority = 10 + $Number
        Role = "interactive"
        Number = $Number
        Label = "Main-$padded"
        PackageName = $package.Name
        ProfilePath = Join-Path $env:LOCALAPPDATA ("Packages\{0}\LocalCache\Roaming\ChatGPT" -f $package.PackageFamilyName)
        DebugPort = $port
        Running = $true
        SignedIn = $true
        Method = "cdp-session-seed"
    }
}

function Get-WorkerCandidate {
    param([Parameter(Mandatory)][int]$Number)
    $padded = "{0:D2}" -f $Number
    $package = Get-AppxPackage -Name "OpenAI.ChatGPT-Desktop.Worker$padded" -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if (-not $package) { return $null }
    $exe = Join-Path $package.InstallLocation "app\ChatGPT Classic.exe"
    $root = Get-RootProcessForExecutable -ExecutablePath $exe
    $port = $workerDebugBasePort + $Number
    if (-not $root -or -not (Test-SignedInPort -Port $port)) { return $null }
    [pscustomobject]@{
        Priority = 100 + $Number
        Role = "worker"
        Number = $Number
        Label = "Runtime-$padded"
        PackageName = $package.Name
        ProfilePath = Join-Path $env:LOCALAPPDATA ("Packages\{0}\LocalCache\Roaming\ChatGPT" -f $package.PackageFamilyName)
        DebugPort = $port
        Running = $true
        SignedIn = $true
        Method = "cdp-session-seed"
    }
}

function Get-PrimaryCandidate {
    $package = Get-AppxPackage -Name "OpenAI.ChatGPT-Desktop" -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if (-not $package) { return $null }
    $exe = Join-Path $package.InstallLocation "app\ChatGPT Classic.exe"
    $root = Get-RootProcessForExecutable -ExecutablePath $exe
    $profile = Join-Path $env:LOCALAPPDATA ("Packages\{0}\LocalCache\Roaming\ChatGPT" -f $package.PackageFamilyName)
    if (-not $root -or -not (Test-Path -LiteralPath $profile)) { return $null }
    [pscustomobject]@{
        Priority = 1000
        Role = "primary"
        Number = 1
        Label = "Main-01"
        PackageName = $package.Name
        ProfilePath = $profile
        DebugPort = $null
        Running = $true
        SignedIn = $null
        Method = "primary-profile"
    }
}

# Priority is intentional: interactive CDP -> worker CDP -> primary profile.
$candidates = @()
foreach ($number in 2..32) {
    if ($number -eq $TargetMainNumber) { continue }
    $candidate = Get-InteractiveCandidate -Number $number
    if ($candidate) { $candidates += $candidate }
}
foreach ($number in 1..32) {
    $candidate = Get-WorkerCandidate -Number $number
    if ($candidate) { $candidates += $candidate }
}
$primary = Get-PrimaryCandidate
if ($primary) { $candidates += $primary }

[ordered]@{
    Ok = $true
    TargetMainNumber = $TargetMainNumber
    Candidates = @($candidates | Sort-Object Priority)
    SecretValuesLogged = $false
} | ConvertTo-Json -Depth 7 -Compress
