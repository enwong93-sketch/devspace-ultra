[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet("open", "show", "restore", "minimize", "stop", "status")]
    [string]$Action,

    [ValidateRange(0, 32)]
    [int]$MainNumber = 0,

    [ValidateRange(5, 60)]
    [int]$VerifyTimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
$interactiveManager = Join-Path $PSScriptRoot "chat-classic-interactive-runtime.ps1"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DevSpaceMainWindowApi {
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@ -ErrorAction SilentlyContinue

function Get-InteractiveRuntime {
    param([Parameter(Mandatory)][int]$Number)
    $padded = "{0:D2}" -f $Number
    $package = Get-AppxPackage -Name "OpenAI.ChatGPT-Desktop.Interactive$padded" -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1
    $exe = if ($package) { Join-Path $package.InstallLocation "app\ChatGPT Classic.exe" } else { $null }
    $root = if ($exe) {
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                $_.Name -eq "ChatGPT Classic.exe" -and
                $_.ExecutablePath -eq $exe -and
                $_.CommandLine -notlike "*--type=*"
            } |
            Sort-Object CreationDate |
            Select-Object -First 1
    } else { $null }
    $process = if ($root) { Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue } else { $null }
    [pscustomobject]@{
        Number = $Number
        Label = "Main-$padded"
        PackageName = "OpenAI.ChatGPT-Desktop.Interactive$padded"
        Registered = [bool]$package
        ExecutablePath = $exe
        Running = [bool]$root
        Pid = if ($root) { [int]$root.ProcessId } else { $null }
        WindowHandle = if ($process) { [long]$process.MainWindowHandle } else { 0 }
        Visible = [bool]($process -and $process.MainWindowHandle -ne 0)
    }
}

function Find-FreeMainNumber {
    foreach ($number in 2..32) {
        $runtime = Get-InteractiveRuntime -Number $number
        if (-not $runtime.Registered) { return $number }
    }
    throw "No free secondary Main number is available from Main-02 through Main-32."
}

function Resolve-MainNumber {
    if ($MainNumber -ge 2) { return $MainNumber }
    if ($Action -eq "open") { return Find-FreeMainNumber }
    throw "$Action requires -MainNumber 2..32."
}

function Invoke-Manager {
    param(
        [Parameter(Mandatory)][string]$ManagerAction,
        [Parameter(Mandatory)][int]$Number
    )
    if (-not (Test-Path -LiteralPath $interactiveManager)) { throw "Interactive manager is missing." }
    $output = @(& $interactiveManager -Action $ManagerAction -MainNumber $Number -VerifyTimeoutSeconds $VerifyTimeoutSeconds)
    # The child is another PowerShell script. With ErrorActionPreference=Stop,
    # terminating errors already propagate. LASTEXITCODE belongs to native
    # executables and may contain a stale value from commands run inside the child.
    $text = ($output -join "`n").Trim()
    try { return $text | ConvertFrom-Json }
    catch { throw "Interactive manager returned invalid JSON." }
}

function Set-MainWindowState {
    param(
        [Parameter(Mandatory)][int]$Number,
        [Parameter(Mandatory)][ValidateSet("show", "restore", "minimize")][string]$State
    )
    $runtime = Get-InteractiveRuntime -Number $Number
    if (-not $runtime.Registered) { throw "$($runtime.Label) is not registered." }
    if (-not $runtime.Running) {
        $null = Invoke-Manager -ManagerAction "start" -Number $Number
        $runtime = Get-InteractiveRuntime -Number $Number
    }
    if (-not $runtime.WindowHandle) { throw "$($runtime.Label) has no user-facing window handle." }
    $handle = [IntPtr]::new([long]$runtime.WindowHandle)
    switch ($State) {
        "minimize" {
            [void][DevSpaceMainWindowApi]::ShowWindow($handle, 6)
        }
        default {
            [void][DevSpaceMainWindowApi]::ShowWindow($handle, 9)
            [void][DevSpaceMainWindowApi]::SetForegroundWindow($handle)
        }
    }
    Start-Sleep -Milliseconds 250
    $after = Get-InteractiveRuntime -Number $Number
    [ordered]@{
        Ok = $true
        Action = $State
        Number = $Number
        Label = $after.Label
        Registered = $after.Registered
        Running = $after.Running
        Pid = $after.Pid
        WindowHandle = $after.WindowHandle
        WorkerManaged = $false
        AutoCompactManaged = $false
        ChatSwarmAutojoin = $false
    }
}

if ($Action -eq "status" -and $MainNumber -eq 0) {
    $rows = @()
    foreach ($number in 2..32) {
        $runtime = Get-InteractiveRuntime -Number $number
        if ($runtime.Registered) { $rows += $runtime }
    }
    [ordered]@{
        Ok = $true
        Action = "status"
        Interactives = $rows
        WorkerManaged = $false
        AutoCompactManaged = $false
    } | ConvertTo-Json -Depth 7 -Compress
    exit 0
}

$number = Resolve-MainNumber
switch ($Action) {
    "open" {
        $result = Invoke-Manager -ManagerAction "setup" -Number $number
        [ordered]@{
            Ok = [bool]$result.Ok
            Action = "open"
            SelectedMainNumber = $number
            SelectedAutomatically = [bool]($MainNumber -eq 0)
            Result = $result
        } | ConvertTo-Json -Depth 10 -Compress
    }
    "show" {
        Set-MainWindowState -Number $number -State "show" | ConvertTo-Json -Depth 7 -Compress
    }
    "restore" {
        Set-MainWindowState -Number $number -State "restore" | ConvertTo-Json -Depth 7 -Compress
    }
    "minimize" {
        Set-MainWindowState -Number $number -State "minimize" | ConvertTo-Json -Depth 7 -Compress
    }
    "stop" {
        $result = Invoke-Manager -ManagerAction "stop" -Number $number
        [ordered]@{ Ok = [bool]$result.Ok; Action = "stop"; Number = $number; Result = $result } | ConvertTo-Json -Depth 9 -Compress
    }
    "status" {
        $result = Invoke-Manager -ManagerAction "status" -Number $number
        [ordered]@{ Ok = [bool]$result.Ok; Action = "status"; Number = $number; Result = $result } | ConvertTo-Json -Depth 9 -Compress
    }
}
