[CmdletBinding()]
param(
    [ValidateSet("DuckDNS", "Cloudflare", "Local")]
    [string] $Network = "DuckDNS",
    [string] $DuckDnsDomain = $env:DEVSPACE_DUCKDNS_DOMAIN,
    [string] $PublicHostname = $env:DEVSPACE_PUBLIC_HOSTNAME,
    [string] $AllowedRoot = $HOME,
    [switch] $NonInteractive,
    [switch] $SkipCaddy,
    [switch] $EnableRouterUpnp,
    [switch] $ManualPortForward,
    [string] $PublicWanIPv4,
    [switch] $MigrateLegacyIngress
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
    $existing = $Object.PSObject.Properties.Match($Name)
    if ($existing.Count -gt 0) { $existing[0].Value = $Value }
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
    if (-not $plain -and (Test-Path -LiteralPath $Path)) {
        try {
            $encrypted = (Get-Content -LiteralPath $Path -Raw -ErrorAction Stop).Trim()
            if (-not $encrypted) { throw 'Protected secret file is empty.' }
            $existingSecure = ConvertTo-SecureString $encrypted -ErrorAction Stop
            $credential = New-Object System.Net.NetworkCredential('', $existingSecure)
            if ([string]::IsNullOrWhiteSpace($credential.Password)) { throw 'Protected secret is empty.' }
            $credential = $null
            return $Path
        } catch {
            if ($NonInteractive) { throw "$EnvironmentName existing DPAPI secret is invalid; provide a new process-scoped value." }
            Write-Warning "Existing protected secret is invalid and will be replaced through a masked prompt."
        }
    }
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

function Find-WingetExecutable([string] $Command, [string] $PackageId) {
    $existing = Get-Command $Command -ErrorAction SilentlyContinue
    if ($existing) { return $existing.Source }
    $link = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\$Command"
    if (Test-Path -LiteralPath $link -PathType Leaf) { return $link }
    $root = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    $packages = @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "$PackageId`_*" })
    $candidates = @($packages | ForEach-Object {
        Get-ChildItem -LiteralPath $_.FullName -Filter $Command -File -Recurse -Depth 3 -ErrorAction SilentlyContinue
    })
    if ($candidates.Count -eq 1) { return $candidates[0].FullName }
    if ($candidates.Count -gt 1) { throw "$PackageId has ambiguous installed executable paths." }
    return $null
}

function Ensure-WingetPackage([string] $Command, [string] $PackageId) {
    $existing = Find-WingetExecutable -Command $Command -PackageId $PackageId
    if ($existing) { return $existing }
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw "winget is required to install $PackageId."
    }
    & winget.exe install --exact --id $PackageId --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "$PackageId installation failed with exit code $LASTEXITCODE." }
    $env:Path = "$( [Environment]::GetEnvironmentVariable('Path','Machine') );$( [Environment]::GetEnvironmentVariable('Path','User') )"
    $installed = Find-WingetExecutable -Command $Command -PackageId $PackageId
    if (-not $installed) { throw "$Command is unavailable after installing $PackageId." }
    return $installed
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

function Normalize-DuckDnsHostname([string] $Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { throw 'A DuckDNS subdomain or hostname is required for this computer.' }
    $text = Normalize-Hostname $Value
    $suffix = '.duckdns.org'
    $subdomain = if ($text.EndsWith($suffix, [StringComparison]::OrdinalIgnoreCase)) {
        $text.Substring(0, $text.Length - $suffix.Length)
    } else {
        $text
    }
    if ($subdomain -notmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$') {
        throw 'Use a DuckDNS subdomain or its full DuckDNS hostname for this computer.'
    }
    return "$subdomain$suffix"
}

function Wait-ForGateway {
    $deadline = (Get-Date).AddSeconds(90)
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
        if ((Get-Date) -ge $deadline) { throw "Local Gateway did not become ready within 90 seconds." }
        Start-Sleep -Milliseconds 500
    }
}

if ($MyInvocation.InvocationName -eq '.') { return }

if (-not (Test-Administrator)) {
    throw "Administrator elevation is required. Run the root install.ps1 entry point, which requests elevation automatically."
}

New-Item -ItemType Directory -Path $ConfigDir, $StateDir, $LogDir, $SecretDir, $GeneratedDir -Force | Out-Null

$hostname = $null
$legacyTaskNames = @()
$legacyCaddyFile = $null
$publicBaseUrl = "http://127.0.0.1:7678"
if ($Network -eq "DuckDNS") {
    if (-not $DuckDnsDomain) {
        if ($NonInteractive) { throw "DuckDnsDomain is required in non-interactive DuckDNS mode." }
        $DuckDnsDomain = Read-Host "DuckDNS subdomain or hostname"
    }
    $hostname = Normalize-DuckDnsHostname $DuckDnsDomain
    $publicBaseUrl = "https://$hostname"
    if (-not $SkipCaddy) {
        if ($EnableRouterUpnp -and $ManualPortForward) { throw 'Choose either UPnP or manual router forwarding, not both.' }
        $legacyTaskNames = @(@('DevSpace-Ultra-DuckDNS', 'DevSpace-Ultra-Caddy') |
            Where-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue })
        if ($legacyTaskNames.Count -gt 0 -and -not $MigrateLegacyIngress) {
            if ($NonInteractive) {
                throw "Legacy DuckDNS/Caddy tasks are present. Explicit -MigrateLegacyIngress is required for guarded one-time adoption."
            }
            $migrationConsent = Read-Host "Back up and disable the legacy ingress tasks after the maintained ingress works? Type MIGRATE"
            if ($migrationConsent -cne 'MIGRATE') {
                throw "Legacy ingress was preserved. No second ingress was started."
            }
        }
        if ($legacyTaskNames -contains 'DevSpace-Ultra-Caddy') {
            $legacyCaddyFile = Join-Path $GeneratedDir 'Caddyfile'
            $legacyCaddyTask = Get-ScheduledTask -TaskName 'DevSpace-Ultra-Caddy' -ErrorAction Stop
            if (-not (Test-Path -LiteralPath $legacyCaddyFile -PathType Leaf) -or
                [string]$legacyCaddyTask.Actions[0].Arguments -notlike "*$legacyCaddyFile*") {
                throw 'Legacy Caddy task does not own the expected generated Caddyfile; refusing automatic adoption.'
            }
        }
        if ($ManualPortForward) {
            if (-not $PublicWanIPv4) {
                if ($NonInteractive) { throw 'Manual forwarding requires -PublicWanIPv4 from the router WAN page.' }
                $PublicWanIPv4 = Read-Host 'Enter the public IPv4 shown on the router WAN page'
            }
            if (-not $NonInteractive) {
                $confirmation = Read-Host 'Confirm router TCP 80 and 443 forward to this PC and type FORWARDED'
                if ($confirmation -cne 'FORWARDED') { throw 'Manual router forwarding was not confirmed.' }
            }
        } elseif (-not $EnableRouterUpnp) {
            if ($NonInteractive) {
                throw "Direct DuckDNS ingress needs explicit -EnableRouterUpnp consent to request router TCP 80/443 mappings. No router settings were changed."
            }
            $consent = Read-Host "Allow DevSpace to request router TCP 80/443 UPnP mappings to this PC? Type YES to continue"
            if ($consent -cne 'YES') {
                throw "Router mapping was not authorized. No router settings were changed; use -Network Local or a separately configured public ingress."
            }
        }
    }
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
if ($config.PSObject.Properties.Match('pluginPaths').Count -eq 0) { Set-Property $config "pluginPaths" @() }
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
if ($config.PSObject.Properties.Match('serverInstanceId').Count -eq 0 -or [string]::IsNullOrWhiteSpace([string]$config.serverInstanceId)) {
    Set-Property $config "serverInstanceId" ("dsi_" + [guid]::NewGuid().ToString('N'))
}
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
Set-Property $config "goalRoundRecoveryEnabled" $true

Write-AtomicText $ConfigPath (($config | ConvertTo-Json -Depth 100) + "`n")

$node = (Get-Command node.exe -ErrorAction Stop).Source
$gatewayScript = Join-Path $PackageRoot "scripts\devspace-fixed-backend.mjs"
if (-not (Test-Path -LiteralPath $gatewayScript)) { throw "Stable Gateway launcher is missing." }
$runtimeWorkingDirectory = Join-Path $env:LOCALAPPDATA "DevSpaceUltra\RuntimeWorkingDirectory"
New-Item -ItemType Directory -Path $runtimeWorkingDirectory -Force | Out-Null
$gatewayAction = New-ScheduledTaskAction -Execute $node -Argument ('"{0}" --foreground --config-dir "{1}"' -f $gatewayScript, $ConfigDir) -WorkingDirectory $runtimeWorkingDirectory
$gatewayTriggers = @((New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)))
Register-UserTask $GatewayTask $gatewayAction $gatewayTriggers "DevSpace Ultra Stable Local Gateway and Core supervisor"

Stop-ScheduledTask -TaskName $GatewayTask -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Start-ScheduledTask -TaskName $GatewayTask
$health = Wait-ForGateway

if ($Network -eq "DuckDNS") {
    if (-not $SkipCaddy) {
        $caddy = Ensure-WingetPackage "caddy.exe" "CaddyServer.Caddy"
        $secretPath = Join-Path $SecretDir "duckdns-token.dpapi"
        Save-ProtectedSecret $secretPath "DEVSPACE_DUCKDNS_TOKEN" "DuckDNS token" | Out-Null
        $ingressStateDir = Join-Path $HOME '.devspace-local-ingress'
        $ingressTokenPath = Join-Path $ingressStateDir 'duckdns.token.dpapi'
        $ingressConfigPath = Join-Path $ingressStateDir 'config.json'
        if (Test-Path -LiteralPath $ingressConfigPath) {
            $ingressConfig = Get-Content -LiteralPath $ingressConfigPath -Raw | ConvertFrom-Json
            if ([string]$ingressConfig.domain -ne $hostname) {
                throw "Existing local ingress belongs to a different DuckDNS domain; refusing to overwrite it."
            }
        }
        if (-not (Test-Path -LiteralPath $ingressTokenPath)) {
            New-Item -ItemType Directory -Path $ingressStateDir -Force | Out-Null
            Copy-Item -LiteralPath $secretPath -Destination $ingressTokenPath -ErrorAction Stop
        }
        $ingress = Join-Path $PackageRoot 'scripts\devspace-local-ingress.ps1'
        if (-not (Test-Path -LiteralPath $ingress)) { throw 'Maintained local ingress helper is missing.' }
        $ingressArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ingress,
            '-Action', 'install', '-Domain', $hostname, '-GatewayPort', '7678',
            '-StateDir', $ingressStateDir, '-CaddyPath', $caddy)
        $legacyDuckDnsWasEnabled = $false
        if ($legacyTaskNames.Count -gt 0) {
            $backupDir = Join-Path $ConfigDir ('legacy-ingress-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
            foreach ($name in $legacyTaskNames) {
                Write-AtomicText (Join-Path $backupDir "$name.xml") (Export-ScheduledTask -TaskName $name -ErrorAction Stop)
            }
            if ($legacyCaddyFile) {
                Copy-Item -LiteralPath $legacyCaddyFile -Destination (Join-Path $backupDir 'Caddyfile') -ErrorAction Stop
                $ingressArgs += @('-SelectedCaddyfilePath', $legacyCaddyFile)
            }
            if ($legacyTaskNames -contains 'DevSpace-Ultra-DuckDNS') {
                # Prevent the old blank-IP updater from racing the verified WAN update.
                $legacyDuckDnsWasEnabled = (Get-ScheduledTask -TaskName 'DevSpace-Ultra-DuckDNS' -ErrorAction Stop).Settings.Enabled
                Disable-ScheduledTask -TaskName 'DevSpace-Ultra-DuckDNS' -ErrorAction Stop | Out-Null
            }
        }
        if ($ManualPortForward) { $ingressArgs += @('-RouterMode', 'Manual', '-PublicWanIPv4', $PublicWanIPv4) }
        if ([Environment]::GetEnvironmentVariable('DEVSPACE_DUCKDNS_TOKEN', 'Process')) { $ingressArgs += '-RotateToken' }
        try {
            & powershell.exe @ingressArgs
            if ($LASTEXITCODE -ne 0) { throw "DuckDNS router WAN/UPnP/Caddy ingress setup failed with exit code $LASTEXITCODE." }
        } catch {
            if ($legacyDuckDnsWasEnabled) {
                Enable-ScheduledTask -TaskName 'DevSpace-Ultra-DuckDNS' -ErrorAction SilentlyContinue | Out-Null
            }
            throw
        }
        foreach ($name in $legacyTaskNames) {
            Disable-ScheduledTask -TaskName $name -ErrorAction Stop | Out-Null
        }
        if ($legacyTaskNames -contains 'DevSpace-Ultra-Caddy') {
            foreach ($port in @(80, 443)) {
                Get-NetFirewallRule -DisplayName "DevSpace Ultra HTTPS $port" -ErrorAction SilentlyContinue |
                    Remove-NetFirewallRule -ErrorAction Stop
            }
        }
    } else {
        Write-Warning 'Caddy was skipped. No DuckDNS update or public HTTPS entry was configured; public Connector acceptance remains pending.'
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
    state = 'local-ready-public-acceptance-pending'
    publicConnectorVerified = $false
    network = $Network
    publicBaseUrl = $publicBaseUrl
    gatewayPort = 7678
    corePid = $memory.pid
    coreHeapProfile = "system"
    heapLimitMB = [Math]::Round($memory.memory.heapSizeLimit / 1MB, 1)
    autoCompactEnabled = $false
    goalRoundRecoveryEnabled = $true
    secretsPersistedInPlainText = $false
    configPath = $ConfigPath
    stateDir = $StateDir
    manualActions = if ($Network -eq "DuckDNS") {
        if ($SkipCaddy) {
            @('Caddy and DuckDNS were skipped. Configure a separate public HTTPS ingress before connecting ChatGPT.')
        } else {
            @("Verify router WAN/DuckDNS/Caddy status from an independent external network; local health is insufficient.", "Connect the ChatGPT MCP app to $publicBaseUrl/mcp and complete OAuth and a write-capable tool call.")
        }
    } elseif ($Network -eq "Cloudflare") {
        @("Confirm the named tunnel routes $hostname to http://127.0.0.1:7678.", "Connect the ChatGPT MCP app to $publicBaseUrl/mcp and complete OAuth.")
    } else {
        @("Local-only mode is not reachable by ChatGPT over the public internet.")
    }
}
$summary | ConvertTo-Json -Depth 8
