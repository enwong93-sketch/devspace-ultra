[CmdletBinding()]
param(
    [ValidateRange(1, 32)]
    [int]$Count = 1,

    [ValidateRange(1, 32)]
    [int]$FirstWorker = 1,

    [ValidateRange(3, 60)]
    [int]$VerifyTimeoutSeconds = 15
)

$ErrorActionPreference = "Stop"
$results = @()

for ($offset = 0; $offset -lt $Count; $offset++) {
    $number = $FirstWorker + $offset
    $workerId = "worker-{0:D2}" -f $number
    $packageName = "OpenAI.ChatGPT-Desktop.Worker{0:D2}" -f $number
    $aliasName = "chatgpt-classic-worker{0:D2}.exe" -f $number
    $aliasPath = Join-Path $env:LOCALAPPDATA ("Microsoft\WindowsApps\" + $aliasName)

    $package = Get-AppxPackage -Name $packageName -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if (-not $package) {
        throw "$workerId runtime clone is not registered. Run chat-swarm-classic-runtime-clone.ps1 for this worker first."
    }
    if (-not (Test-Path -LiteralPath $aliasPath)) {
        throw "$workerId execution alias is missing: $aliasPath"
    }

    $runtimeExe = Join-Path $package.InstallLocation "app\ChatGPT Classic.exe"
    $before = @(
        Get-CimInstance Win32_Process |
            Where-Object {
                $_.Name -eq "ChatGPT Classic.exe" -and
                $_.ExecutablePath -eq $runtimeExe -and
                $_.CommandLine -notlike "*--type=*"
            } |
            Select-Object -ExpandProperty ProcessId
    )

    if ($before.Count -gt 0) {
        $results += [pscustomobject]@{
            WorkerId = $workerId
            PackageName = $packageName
            State = "already-running"
            RootPid = ($before -join ",")
            WindowTitle = ((Get-Process -Id $before[0] -ErrorAction SilentlyContinue).MainWindowTitle)
        }
        continue
    }

    Start-Process -FilePath $aliasPath -WorkingDirectory $env:LOCALAPPDATA | Out-Null
    $deadline = (Get-Date).AddSeconds($VerifyTimeoutSeconds)
    $root = @()
    do {
        Start-Sleep -Milliseconds 500
        $root = @(
            Get-CimInstance Win32_Process |
                Where-Object {
                    $_.Name -eq "ChatGPT Classic.exe" -and
                    $_.ExecutablePath -eq $runtimeExe -and
                    $_.CommandLine -notlike "*--type=*"
                }
        )
    } while ($root.Count -eq 0 -and (Get-Date) -lt $deadline)

    if ($root.Count -eq 0) {
        throw "$workerId was launched but no independent ChatGPT Classic root process appeared before timeout."
    }

    $rootPid = $root[0].ProcessId
    $process = Get-Process -Id $rootPid -ErrorAction SilentlyContinue
    $results += [pscustomobject]@{
        WorkerId = $workerId
        PackageName = $packageName
        State = "running"
        RootPid = $rootPid
        WindowTitle = $process.MainWindowTitle
    }
}

$results | Format-Table -AutoSize
