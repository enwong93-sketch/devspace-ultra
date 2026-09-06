param(
    [ValidateSet(7688, 7689)]
    [int]$Port = 7688,
    [ValidateRange(0, 30)]
    [int]$DelaySeconds = 0,
    [string]$MarkerPath = "$env:TEMP\devspace-stable-gateway-core-exit-live-gate.json"
)

$ErrorActionPreference = "Stop"

function Write-Marker {
    param(
        [Parameter(Mandatory)][string]$State,
        [int]$Pid = 0,
        [string]$ErrorText = $null
    )
    $payload = [ordered]@{
        ok = ($State -eq "killed")
        state = $State
        port = $Port
        pid = if ($Pid -gt 0) { $Pid } else { $null }
        error = $ErrorText
        at = (Get-Date).ToUniversalTime().ToString("o")
    }
    $directory = Split-Path -Parent $MarkerPath
    if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
    $payload | ConvertTo-Json -Compress | Set-Content -LiteralPath $MarkerPath -Encoding UTF8
}

try {
    if ($DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }

    $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
    if (-not $connection) {
        Write-Marker -State "refused-no-listener" -ErrorText "No listener exists on the requested Core port."
        exit 41
    }

    $process = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f [int]$connection.OwningProcess) -ErrorAction Stop
    $commandLine = [string]$process.CommandLine
    $isDevSpaceCore = (
        $process.Name -eq "node.exe" -and
        $commandLine -match 'dist[\\/]cli\.js' -and
        $commandLine -match '\bserve\b'
    )
    if (-not $isDevSpaceCore) {
        Write-Marker -State "refused-unexpected-listener" -Pid ([int]$process.ProcessId) -ErrorText "Listener is not a verified DevSpace Core process."
        exit 42
    }

    $pidToKill = [int]$process.ProcessId
    Stop-Process -Id $pidToKill -Force -ErrorAction Stop
    Write-Marker -State "killed" -Pid $pidToKill
    exit 0
}
catch {
    Write-Marker -State "failed" -ErrorText $_.Exception.Message
    exit 43
}
