[CmdletBinding()]
param(
    [ValidateSet("overview", "metadata-get", "metadata-set", "diagnostics")]
    [string]$Action = "overview",
    [ValidateRange(1,32)]
    [int]$Worker = 1,
    [ValidateLength(0,80)]
    [string]$Label = "",
    [ValidateLength(0,240)]
    [string]$Specialization = ""
)

$ErrorActionPreference = "Stop"
$stateDir = Join-Path $env:LOCALAPPDATA "DevSpace\ChatSwarmClassic"
$metadataPath = Join-Path $stateDir "worker-metadata.json"
$bootstrap = Join-Path $PSScriptRoot "chat-swarm-classic-cdp-bootstrap.mjs"

function Read-Metadata {
    if (-not (Test-Path -LiteralPath $metadataPath)) { return @{} }
    try {
        $raw = [System.IO.File]::ReadAllText($metadataPath, [System.Text.Encoding]::UTF8)
        $parsed = $raw | ConvertFrom-Json
        $map = @{}
        foreach ($row in @($parsed.workers)) { $map[[string]$row.worker] = $row }
        return $map
    } catch { return @{} }
}

function Write-Metadata([hashtable]$Map) {
    New-Item -ItemType Directory -Force $stateDir | Out-Null
    $rows = @($Map.GetEnumerator() | Sort-Object { [int]$_.Key } | ForEach-Object {
        [ordered]@{ worker=[int]$_.Key; label=[string]$_.Value.label; specialization=[string]$_.Value.specialization }
    })
    $text = ([ordered]@{ version=1; workers=$rows } | ConvertTo-Json -Depth 5) + "`n"
    [System.IO.File]::WriteAllText($metadataPath, $text, [System.Text.UTF8Encoding]::new($false))
}

function Test-Port([int]$Port) {
    try { $client=[System.Net.Sockets.TcpClient]::new(); $task=$client.ConnectAsync('127.0.0.1',$Port); if(-not $task.Wait(250)){ $client.Dispose(); return $false }; $ok=$client.Connected; $client.Dispose(); return $ok } catch { return $false }
}

function Get-WorkerRow([int]$Number, [hashtable]$Metadata) {
    $padded = '{0:D2}' -f $Number
    $name = "OpenAI.ChatGPT-Desktop.Worker$padded"
    $package = Get-AppxPackage -Name $name -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1
    $port = 9330 + $Number
    $metadata = $Metadata[[string]$Number]
    if (-not $package) { return [ordered]@{ worker=$Number; runtime="Worker-$padded"; state='not-provisioned'; label=if($metadata){$metadata.label}else{$null}; specialization=if($metadata){$metadata.specialization}else{$null}; registered=$false; running=$false; debugPort=$port } }
    $exe = Join-Path $package.InstallLocation 'app\ChatGPT Classic.exe'
    $root = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'ChatGPT Classic.exe' -and $_.ExecutablePath -eq $exe -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1
    if (-not $root) { return [ordered]@{ worker=$Number; runtime="Worker-$padded"; state='parked'; label=if($metadata){$metadata.label}else{$null}; specialization=if($metadata){$metadata.specialization}else{$null}; registered=$true; running=$false; debugPort=$port } }
    $state = 'online'
    $signedIn = $null
    if (Test-Port $port) {
        try {
            $node=(Get-Command node -ErrorAction Stop).Source
            $probe = ((@(& $node $bootstrap --port $port --probe --compact) -join "`n") | ConvertFrom-Json).probe
            $signedIn = [bool]($probe.composer -and -not $probe.loginVisible)
            if ($probe.loginVisible -or -not $signedIn) { $state='needs-login' }
            elseif ($probe.connectionInterrupted) { $state='recovering' }
            elseif ($probe.generating) { $state='busy' }
        } catch { $state='unresponsive' }
    }
    else { $state='online-no-cdp' }
    [ordered]@{ worker=$Number; runtime="Worker-$padded"; state=$state; label=if($metadata){$metadata.label}else{$null}; specialization=if($metadata){$metadata.specialization}else{$null}; registered=$true; running=$true; pid=[int]$root.ProcessId; debugPort=$port; signedIn=$signedIn }
}

function Get-Overview {
    $metadata=Read-Metadata
    $rows=@(1..32 | ForEach-Object { Get-WorkerRow $_ $metadata })
    [ordered]@{ ok=$true; action='overview'; workers=$rows; summary=[ordered]@{ provisioned=@($rows|Where-Object registered).Count; online=@($rows|Where-Object {$_.state -in @('online','online-no-cdp','busy','recovering')}).Count; parked=@($rows|Where-Object {$_.state -eq 'parked'}).Count; needsLogin=@($rows|Where-Object {$_.state -eq 'needs-login'}).Count }; workerAutostart=$false; secretValuesLogged=$false }
}

switch($Action) {
    'overview' { Get-Overview | ConvertTo-Json -Depth 8 -Compress }
    'metadata-get' { $map=Read-Metadata; [ordered]@{ ok=$true; action='metadata-get'; workers=@($map.Values); secretValuesLogged=$false } | ConvertTo-Json -Depth 6 -Compress }
    'metadata-set' { $map=Read-Metadata; if ([string]::IsNullOrWhiteSpace($Label) -and [string]::IsNullOrWhiteSpace($Specialization)) { $map.Remove([string]$Worker) } else { $map[[string]$Worker]=[pscustomobject]@{ label=$Label.Trim(); specialization=$Specialization.Trim() } }; Write-Metadata $map; [ordered]@{ok=$true;action='metadata-set';worker=$Worker;label=$Label.Trim();specialization=$Specialization.Trim();secretValuesLogged=$false}|ConvertTo-Json -Compress }
    'diagnostics' { $overview=Get-Overview; $tasks=@('DevSpace-Canonical-Startup','DevSpace-Stable-Gateway','DevSpace-Local-Ingress','DevSpace-Fixed-Backend','DevSpace-Fixed-Edge-Tunnel') | ForEach-Object { $task=Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue; [ordered]@{ task=$_; exists=[bool]$task; enabled=if($task){[bool]$task.Settings.Enabled}else{$false}; state=if($task){$task.State.ToString()}else{$null} } }; [ordered]@{ok=$true;action='diagnostics';overview=$overview.summary;tasks=$tasks;workerAutostart=$false;secretValuesLogged=$false}|ConvertTo-Json -Depth 8 -Compress }
}
