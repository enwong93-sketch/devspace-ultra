[CmdletBinding()]
param(
    [ValidateSet("DuckDNS", "Cloudflare", "Local")]
    [string] $Network = "DuckDNS",
    [string] $DuckDnsDomain = $env:DEVSPACE_DUCKDNS_DOMAIN,
    [string] $PublicHostname = $env:DEVSPACE_PUBLIC_HOSTNAME,
    [string] $AllowedRoot = $HOME,
    [switch] $NonInteractive,
    [switch] $SkipCaddy
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$PackageRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ConfigDir = if ($env:DEVSPACE_CONFIG_DIR) { $env:DEVSPACE_CONFIG_DIR } else { Join-Path $HOME ".devspace-tailscale-bootstrap" }
$StateDir = if ($env:DEVSPACE_STATE_DIR) { $env:DEVSPACE_STATE_DIR } else { Join-Path $HOME ".local\share\devspace-tailscale-bootstrap" }
$ConfigPath = Join-Path $ConfigDir "config.json"
$LogDir = Join-Path $ConfigDir "logs"
$SecretDir = Join-Path $ConfigDir "secrets"
$GeneratedDir = Join-Path $ConfigDir "generated"
$GatewayTask = "DevSpace-Stable-Gateway"

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Set-Property($Object, [string] $Name, $Value) {
    if ($Object.PSObject.Properties.Name -contains $Name) { $Object.$Name = $Value }
    else { $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

function Write-AtomicText([string] $Path, [string] $Text) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($temporary, $Text, [Text.UTF8Encoding]::new($false))
    $delay = 8
    while ($true) {
        try {
            Move-Item -LiteralPath $temporary -Destination $Path -Force
            break
        }
        catch {
            if ($_.Exception.HResult -notin @(-2147024891, -2147024864)) { throw }
            Start-Sleep -Milliseconds $delay
            $delay = [Math]::Min(250, [Math]::Ceiling($delay * 1.5))
        }
    }
}

function Save-ProtectedSecret([string] $Path, [string] $EnvironmentName, [string] $Prompt) {
    $plain = [Environment]::GetEnvironmentVariable($EnvironmentName, "Process")
    if ($plain) {
        $secure = ConvertTo-SecureString $plain -AsPlainText -Force
    }
    elseif ($NonInteractive) {
        throw "$EnvironmentName is required in non-interactive mode."
    }
    else {
        $secure = Read-Host $Prompt -AsSecureString
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
    Write-AtomicText $Path ($secure | ConvertFrom-SecureString)
    return $Path
}

function Ensure-WingetPackage([string] $Command, [string] $PackageId) {
    $existing = Get-Command $Command -ErrorAction SilentlyContinue
    if ($existing) { return $existing.Source }
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw "winget is required to install $PackageId."
    }
    & winget.exe install --exact --id $PackageId --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "$PackageId installation failed with exit code $LASTEXITCODE." }
    $env:Path = "$( [Environment]::GetEnvironmentVariable('Path','Machine') );$( [Environment]::GetEnvironmentVariable('Path','User') )"
    $installed = Get-Command $Command -ErrorAction SilentlyContinue
    if (-not $installed) { throw "$Command is unavailable after installing $PackageId." }
    return $installed.Source
}

function New-UnlimitedTaskSettings {
    return New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero)
}

function Register-UserTask([string] $Name, $Action, $Triggers, [string] $Description) {
    $principal = New-ScheduledTaskPrincipal `
        -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType Interactive `
        -RunLevel Highest
    Register-ScheduledTask `
        -TaskName $Name `
        -Action $Action `
        -Trigger $Triggers `
        -Settings (New-UnlimitedTaskSettings) `
        -Principal $principal `
        -Description $Description `
        -Force | Out-Null
}

function Normalize-Hostname([string] $Value) {
    $text = $Value.Trim().ToLowerInvariant()
    $text = $text -replace '^https?://', ''
    $text = $text.TrimEnd('/')
    if ($text -notmatch '^[a-z0-9.-]+$') { throw "Invalid public hostname: $Value" }
    return $text
}

function Wait-ForGateway {
    while ($true) {
        try {
            $health = Invoke-RestMethod "http://127.0.0.1:7678/healthz"
            if ($health.ok -eq $true) { return $health }
        }
        catch {}
        $task = Get-ScheduledTask -TaskName $GatewayTask -ErrorAction SilentlyContinue
        $taskInfo = Get-ScheduledTaskInfo -TaskName $GatewayTask -ErrorAction SilentlyContinue
        $listener = Get-NetTCPConnection -State Listen -LocalPort 7678 -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $listener -and $task -and $task.State -ne "Running" -and $taskInfo.LastTaskResult -notin @(0, 267009)) {
            throw "Local Gateway exited before readiness (Task result $($taskInfo.LastTaskResult))."
        }
        Start-Sleep -Milliseconds 500
    }
}

if (-not (Test-Administrator)) {
    throw "Administrator elevation is required. Run the root install.ps1 entry point, which requests elevation automatically."
}

New-Item -ItemType Directory -Path $ConfigDir, $StateDir, $LogDir, $SecretDir, $GeneratedDir -Force | Out-Null

$hostname = $null
$publicBaseUrl = "http://127.0.0.1:7678"
if ($Network -eq "DuckDNS") {
    if (-not $DuckDnsDomain) {
        if ($NonInteractive) { throw "DuckDnsDomain is required in non-interactive DuckDNS mode." }
        $DuckDnsDomain = Read-Host "DuckDNS subdomain or hostname"
    }
    $hostname = Normalize-Hostname $DuckDnsDomain
    if ($hostname -notmatch '\.duckdns\.org$') { $hostname = "$hostname.duckdns.org" }
    $publicBaseUrl = "https://$hostname"
}
elseif ($Network -eq "Cloudflare") {
    if (-not $PublicHostname) {
        if ($NonInteractive) { throw "PublicHostname is required in non-interactive Cloudflare mode." }
        $PublicHostname = Read-Host "Stable Cloudflare public hostname"
    }
    $hostname = Normalize-Hostname $PublicHostname
    $publicBaseUrl = "https://$hostname"
}

$config = if (Test-Path -LiteralPath $ConfigPath) {
    Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
} else { [pscustomobject]@{} }

$allowedHosts = @("localhost", "127.0.0.1", "::1")
if ($hostname) { $allowedHosts += $hostname }
Set-Property $config "allowedHosts" @($allowedHosts | Select-Object -Unique)
Set-Property $config "allowedRoots" @((Resolve-Path $AllowedRoot).Path)
Set-Property $config "worktreeRoot" (Join-Path $HOME ".devspace\worktrees")
if (-not ($config.PSObject.Properties.Name -contains "pluginPaths")) { Set-Property $config "pluginPaths" @() }
Set-Property $config "toolMode" "ultra"
Set-Property $config "pluginsEnabled" $true
Set-Property $config "skillsEnabled" $true
Set-Property $config "artifactsEnabled" $true
Set-Property $config "classicStreamRecoveryEnabled" $true
Set-Property $config "contextGuardianEnabled" $true
Set-Property $config "classicHostOverlayEnabled" $true
Set-Property $config "host" "127.0.0.1"
Set-Property $config "port" 7678
Set-Property $config "publicBaseUrl" $publicBaseUrl
Set-Property $config "stateDir" $StateDir
Set-Property $config "stableGatewayPort" 7678
Set-Property $config "stableGatewayPublicBaseUrl" $publicBaseUrl
Set-Property $config "stableGatewayStateDir" $StateDir
Set-Property $config "stableGatewayCoreAPort" 7688
Set-Property $config "stableGatewayCoreBPort" 7689
Set-Property $config "stableGatewayCoreHeapProfile" "system"
Set-Property $config "edgeBackendPort" 7678
Set-Property $config "edgePublicBaseUrl" $publicBaseUrl
Set-Property $config "edgeFixedStateDir" $StateDir
Set-Property $config "autoCompactEnabled" $false
Set-Property $config "goalRoundRecoveryEnabled" $false

Write-AtomicText $ConfigPath (($config | ConvertTo-Json -Depth 100) + "`n")

$node = (Get-Command node.exe -ErrorAction Stop).Source
$gatewayScript = Join-Path $PackageRoot "scripts\devspace-stable-gateway.mjs"
$gatewayAction = New-ScheduledTaskAction -Execute $node -Argument ('"{0}"' -f $gatewayScript) -WorkingDirectory $PackageRoot
$gatewayTriggers = @((New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)))
Register-UserTask $GatewayTask $gatewayAction $gatewayTriggers "DevSpace Ultra Stable Local Gateway and Core supervisor"

if ($Network -eq "DuckDNS") {
    $secretPath = Join-Path $SecretDir "duckdns-token.dpapi"
    Save-ProtectedSecret $secretPath "DEVSPACE_DUCKDNS_TOKEN" "DuckDNS token" | Out-Null
    $statusPath = Join-Path $StateDir "duckdns-status.json"
    $updateScript = Join-Path $PackageRoot "scripts\devspace-duckdns-update.ps1"
    $duckAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Domain "{1}" -SecretPath "{2}" -StatusPath "{3}"' -f $updateScript, $hostname, $secretPath, $statusPath)
    $repetition = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
    $logon = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
    Register-UserTask "DevSpace-Ultra-DuckDNS" $duckAction @($repetition, $logon) "Refresh the DuckDNS address used by DevSpace Ultra"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $updateScript -Domain $hostname -SecretPath $secretPath -StatusPath $statusPath
    if ($LASTEXITCODE -ne 0) { throw "Initial DuckDNS update failed." }

    if (-not $SkipCaddy) {
        $caddy = Ensure-WingetPackage "caddy.exe" "CaddyServer.Caddy"
        $caddyFile = Join-Path $GeneratedDir "Caddyfile"
        $caddyText = @"
$hostname {
    encode zstd gzip
    reverse_proxy 127.0.0.1:7678
    header {
        X-Content-Type-Options nosniff
        Referrer-Policy no-referrer
    }
}
"@
        Write-AtomicText $caddyFile $caddyText
        $caddyAction = New-ScheduledTaskAction -Execute $caddy -Argument ('run --config "{0}" --adapter caddyfile' -f $caddyFile) -WorkingDirectory $GeneratedDir
        Register-UserTask "DevSpace-Ultra-Caddy" $caddyAction $gatewayTriggers "TLS reverse proxy for the DevSpace Ultra DuckDNS endpoint"
        foreach ($port in @(80, 443)) {
            $ruleName = "DevSpace Ultra HTTPS $port"
            if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
                New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port | Out-Null
            }
        }
        Start-ScheduledTask -TaskName "DevSpace-Ultra-Caddy"
    }
}
elseif ($Network -eq "Cloudflare") {
    Write-Warning "Cloudflare fallback is quota-governed when a Worker relay/free plan is used. Review the current Cloudflare plan limits before production use."
    $cloudflared = Ensure-WingetPackage "cloudflared.exe" "Cloudflare.cloudflared"
    $secretPath = Join-Path $SecretDir "cloudflare-tunnel-token.dpapi"
    Save-ProtectedSecret $secretPath "DEVSPACE_CLOUDFLARE_TUNNEL_TOKEN" "Cloudflare named-tunnel token" | Out-Null
    $runner = Join-Path $PackageRoot "scripts\devspace-cloudflare-run.ps1"
    $runtimeDirectory = Join-Path $StateDir "cloudflared-runtime"
    $cloudflareAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -CloudflaredPath "{1}" -SecretPath "{2}" -RuntimeDirectory "{3}"' -f $runner, $cloudflared, $secretPath, $runtimeDirectory)
    Register-UserTask "DevSpace-Ultra-Cloudflare" $cloudflareAction $gatewayTriggers "Cloudflare named-tunnel fallback for DevSpace Ultra"
    Start-ScheduledTask -TaskName "DevSpace-Ultra-Cloudflare"
}

Stop-ScheduledTask -TaskName $GatewayTask -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Start-ScheduledTask -TaskName $GatewayTask
$health = Wait-ForGateway

$memory = $null
foreach ($port in @(7688, 7689)) {
    try {
        $candidate = Invoke-RestMethod "http://127.0.0.1:$port/__devspace/memory/status"
        if ($candidate.ok -eq $true) { $memory = $candidate; break }
    }
    catch {}
}
if (-not $memory) { throw "Gateway is healthy, but no Core memory endpoint is available." }

$summary = [ordered]@{
    ok = $true
    network = $Network
    publicBaseUrl = $publicBaseUrl
    gatewayPort = 7678
    corePid = $memory.pid
    coreHeapProfile = "system"
    heapLimitMB = [Math]::Round($memory.memory.heapSizeLimit / 1MB, 1)
    autoCompactEnabled = $false
    goalRoundRecoveryEnabled = $false
    secretsPersistedInPlainText = $false
    configPath = $ConfigPath
    stateDir = $StateDir
    manualActions = if ($Network -eq "DuckDNS") {
        @("Forward public TCP 80 and 443 to this computer if the router does not already do so.", "Connect the ChatGPT MCP app to $publicBaseUrl/mcp and complete OAuth.")
    } elseif ($Network -eq "Cloudflare") {
        @("Confirm the named tunnel routes $hostname to http://127.0.0.1:7678.", "Connect the ChatGPT MCP app to $publicBaseUrl/mcp and complete OAuth.")
    } else {
        @("Local-only mode is not reachable by ChatGPT over the public internet.")
    }
}
$summary | ConvertTo-Json -Depth 8
