[CmdletBinding()]
param(
    [ValidateSet("install", "run", "status", "refresh", "remove")]
    [string]$Action = "status",
    [string]$Domain,
    [string]$InterfaceAlias,
    [int]$GatewayPort = 7678,
    [string]$StateDir = (Join-Path $env:USERPROFILE ".devspace-local-ingress"),
    [switch]$RotateToken
)

$ErrorActionPreference = "Stop"
$taskName = "DevSpace-Local-Ingress"
$firewallName = "DevSpace Caddy HTTPS"
$scriptPath = $MyInvocation.MyCommand.Path
$configPath = Join-Path $StateDir "config.json"
$tokenPath = Join-Path $StateDir "duckdns.token.dpapi"
$statusPath = Join-Path $StateDir "status.json"
$logDir = Join-Path $StateDir "logs"
$script:caddyProcess = $null

function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    $parent = Split-Path $Path -Parent
    if ($parent) { New-Item -ItemType Directory -Force $parent | Out-Null }
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

function Write-JsonFile {
    param([string]$Path, $Value)
    Write-Utf8NoBom -Path $Path -Text (($Value | ConvertTo-Json -Depth 8) + "`n")
}

function Read-Config {
    if (-not (Test-Path -LiteralPath $configPath)) { throw "Local ingress config is missing: $configPath" }
    return (Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json)
}

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Normalize-Domain {
    param([string]$Value)
    $value = ([string]$Value).Trim().ToLowerInvariant()
    if ($value -notmatch '^[a-z0-9][a-z0-9-]{0,62}\.duckdns\.org$') {
        throw "Domain must be one DuckDNS hostname such as devspace-example.duckdns.org."
    }
    return $value
}

function Get-DefaultInterfaceAlias {
    $routes = @(
        Get-NetRoute `
            -AddressFamily IPv4 `
            -DestinationPrefix "0.0.0.0/0" `
            -ErrorAction SilentlyContinue |
            Where-Object {
                $_.NextHop -and
                $_.NextHop -ne "0.0.0.0" -and
                $_.State -eq "Alive"
            } |
            Sort-Object RouteMetric, InterfaceMetric
    )
    foreach ($route in $routes) {
        $adapter = Get-NetAdapter -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue
        if ($adapter -and $adapter.Status -eq "Up") {
            return [string]$adapter.Name
        }
    }
    $fallback = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
        Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq "Up" } |
        Select-Object -First 1
    if ($fallback) { return [string]$fallback.InterfaceAlias }
    throw "Unable to auto-detect the active physical network interface. Pass -InterfaceAlias explicitly."
}

function Get-LanInfo {
    param([string]$Alias)
    $net = Get-NetIPConfiguration -InterfaceAlias $Alias -ErrorAction Stop
    $ip = @($net.IPv4Address | ForEach-Object { $_.IPAddress } | Where-Object { $_ -and $_ -notlike '169.254.*' }) | Select-Object -First 1
    $gateway = @($net.IPv4DefaultGateway | ForEach-Object { $_.NextHop } | Where-Object { $_ }) | Select-Object -First 1
    if (-not $ip -or -not $gateway) { throw "Unable to resolve LAN IPv4/default gateway for interface $Alias." }
    return [pscustomobject]@{ InterfaceAlias = $Alias; LocalIPv4 = [string]$ip; Gateway = [string]$gateway }
}

function Find-UpnpDescriptionLocations {
    param([string]$Gateway)
    $locations = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($candidate in @(
        "http://$Gateway`:1900/ssoyt/rootDesc.xml",
        "http://$Gateway`:1900/rootDesc.xml",
        "http://$Gateway`:5000/rootDesc.xml",
        "http://$Gateway/upnp/IGD.xml",
        "http://$Gateway/igd.xml"
    )) {
        $null = $locations.Add($candidate)
    }
    $udp = $null
    try {
        $udp = New-Object System.Net.Sockets.UdpClient
        $udp.Client.ReceiveTimeout = 500
        $payload = @(
            "M-SEARCH * HTTP/1.1",
            "HOST: 239.255.255.250:1900",
            'MAN: "ssdp:discover"',
            "MX: 2",
            "ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1",
            "",
            ""
        ) -join "`r`n"
        $bytes = [System.Text.Encoding]::ASCII.GetBytes($payload)
        $null = $udp.Send($bytes, $bytes.Length, "239.255.255.250", 1900)
        $deadline = [DateTime]::UtcNow.AddSeconds(3)
        while ([DateTime]::UtcNow -lt $deadline) {
            try {
                $remote = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
                $responseBytes = $udp.Receive([ref]$remote)
                $responseText = [System.Text.Encoding]::ASCII.GetString($responseBytes)
                $match = [regex]::Match($responseText, '(?im)^LOCATION:\s*(\S+)\s*$')
                if (-not $match.Success) { continue }
                $uri = $null
                if (-not [uri]::TryCreate($match.Groups[1].Value.Trim(), [System.UriKind]::Absolute, [ref]$uri)) { continue }
                if ($uri.Scheme -notin @("http", "https")) { continue }
                if ($uri.Host -ne $Gateway) { continue }
                $null = $locations.Add($uri.AbsoluteUri)
            } catch [System.Net.Sockets.SocketException] {
                continue
            }
        }
    } catch {
        # Static descriptor candidates remain available when multicast discovery
        # is blocked by the router or Windows network profile.
    } finally {
        if ($udp) { $udp.Dispose() }
    }
    return @($locations)
}

function Get-UpnpWanService {
    param([string]$Gateway)
    # Query the home router directly rather than a generic internet-IP service,
    # so a machine-wide VPN cannot silently publish its egress IP to DuckDNS.
    foreach ($root in Find-UpnpDescriptionLocations -Gateway $Gateway) {
        try {
            [xml]$desc = (Invoke-WebRequest -UseBasicParsing -Uri $root -TimeoutSec 5).Content
            $svc = $desc.SelectNodes("//*[local-name()='service']") |
                Where-Object { $_.serviceType -match "WANIPConnection|WANPPPConnection" } |
                Select-Object -First 1
            if (-not $svc) { continue }
            $control = [uri]::new([uri]$root, [string]$svc.controlURL).AbsoluteUri
            return [pscustomobject]@{ Root = $root; Control = $control; ServiceType = [string]$svc.serviceType }
        } catch {
            continue
        }
    }
    throw "Router UPnP WANIPConnection/WANPPPConnection service is unavailable. Enable UPnP/port forwarding or use the Cloudflare fallback."
}

function Invoke-UpnpSoap {
    param($Service, [string]$ActionName, [string]$ActionXml)
    $body = @"
<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
 s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    $ActionXml
  </s:Body>
</s:Envelope>
"@
    return Invoke-WebRequest `
        -UseBasicParsing `
        -Uri $Service.Control `
        -Method POST `
        -Headers @{ SOAPAction = '"' + $Service.ServiceType + '#' + $ActionName + '"' } `
        -ContentType 'text/xml; charset="utf-8"' `
        -Body $body `
        -TimeoutSec 8
}

function Get-RouterWanIp {
    param($Service)
    $xml = '<u:GetExternalIPAddress xmlns:u="' + $Service.ServiceType + '"></u:GetExternalIPAddress>'
    $response = Invoke-UpnpSoap -Service $Service -ActionName "GetExternalIPAddress" -ActionXml $xml
    $match = [regex]::Match($response.Content, '<NewExternalIPAddress>([^<]+)</NewExternalIPAddress>')
    if (-not $match.Success) { throw "Router did not return an external IPv4 address." }
    $ip = $match.Groups[1].Value.Trim()
    $parsed = $null
    if (-not [System.Net.IPAddress]::TryParse($ip, [ref]$parsed)) { throw "Router returned an invalid WAN address." }
    $octets = $parsed.GetAddressBytes()
    $privateOrReserved = (
        $octets[0] -eq 10 -or
        ($octets[0] -eq 100 -and $octets[1] -ge 64 -and $octets[1] -le 127) -or
        ($octets[0] -eq 127) -or
        ($octets[0] -eq 169 -and $octets[1] -eq 254) -or
        ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
        ($octets[0] -eq 192 -and $octets[1] -eq 168) -or
        $octets[0] -ge 224
    )
    if ($privateOrReserved) {
        throw "Router WAN address $ip is private/CGNAT/reserved, so direct DuckDNS ingress cannot be verified. Use the Cloudflare fallback or obtain a public IPv4 address."
    }
    return $ip
}

function Get-PortMapping {
    param($Service, [int]$Port)
    $xml = @"
<u:GetSpecificPortMappingEntry xmlns:u="$($Service.ServiceType)">
  <NewRemoteHost></NewRemoteHost>
  <NewExternalPort>$Port</NewExternalPort>
  <NewProtocol>TCP</NewProtocol>
</u:GetSpecificPortMappingEntry>
"@
    try {
        $response = Invoke-UpnpSoap -Service $Service -ActionName "GetSpecificPortMappingEntry" -ActionXml $xml
    } catch {
        $responseObject = $_.Exception.Response
        if ($responseObject -and [int]$responseObject.StatusCode -eq 500) { return $null }
        throw
    }
    $content = [string]$response.Content
    $capture = {
        param([string]$Name)
        $m = [regex]::Match($content, '<' + $Name + '>([^<]*)</' + $Name + '>')
        if ($m.Success) { return $m.Groups[1].Value }
        return $null
    }
    return [pscustomobject]@{
        ExternalPort = $Port
        InternalPort = [int](& $capture "NewInternalPort")
        InternalClient = [string](& $capture "NewInternalClient")
        Description = [string](& $capture "NewPortMappingDescription")
        Enabled = [string](& $capture "NewEnabled")
    }
}

function Remove-PortMapping {
    param($Service, [int]$Port)
    $xml = @"
<u:DeletePortMapping xmlns:u="$($Service.ServiceType)">
  <NewRemoteHost></NewRemoteHost>
  <NewExternalPort>$Port</NewExternalPort>
  <NewProtocol>TCP</NewProtocol>
</u:DeletePortMapping>
"@
    $null = Invoke-UpnpSoap -Service $Service -ActionName "DeletePortMapping" -ActionXml $xml
}

function Add-PortMapping {
    param($Service, [int]$Port, [string]$LocalIPv4)
    $description = "DevSpace-Caddy-$Port"
    $xml = @"
<u:AddPortMapping xmlns:u="$($Service.ServiceType)">
  <NewRemoteHost></NewRemoteHost>
  <NewExternalPort>$Port</NewExternalPort>
  <NewProtocol>TCP</NewProtocol>
  <NewInternalPort>$Port</NewInternalPort>
  <NewInternalClient>$LocalIPv4</NewInternalClient>
  <NewEnabled>1</NewEnabled>
  <NewPortMappingDescription>$description</NewPortMappingDescription>
  <NewLeaseDuration>0</NewLeaseDuration>
</u:AddPortMapping>
"@
    $null = Invoke-UpnpSoap -Service $Service -ActionName "AddPortMapping" -ActionXml $xml
}

function Ensure-PortMapping {
    param($Service, [int]$Port, [string]$LocalIPv4)
    $description = "DevSpace-Caddy-$Port"
    $existing = Get-PortMapping -Service $Service -Port $Port
    if ($existing) {
        if ($existing.Description -ne $description) {
            throw "TCP $Port already belongs to another router mapping; refusing to overwrite it."
        }
        if ($existing.InternalClient -eq $LocalIPv4 -and $existing.InternalPort -eq $Port -and $existing.Enabled -ne "0") {
            return [pscustomobject]@{ Port = $Port; Changed = $false; LocalIPv4 = $LocalIPv4 }
        }
        Remove-PortMapping -Service $Service -Port $Port
    }
    Add-PortMapping -Service $Service -Port $Port -LocalIPv4 $LocalIPv4
    return [pscustomobject]@{ Port = $Port; Changed = $true; LocalIPv4 = $LocalIPv4 }
}

function Get-DuckDnsToken {
    if (-not (Test-Path -LiteralPath $tokenPath)) { throw "DuckDNS DPAPI token is missing. Run install first." }
    $encrypted = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
    $secure = ConvertTo-SecureString $encrypted
    $credential = New-Object System.Net.NetworkCredential("", $secure)
    return $credential.Password
}

function Save-DuckDnsToken {
    $secure = Read-Host "Enter DuckDNS token (it will be stored with Windows DPAPI)" -AsSecureString
    $encrypted = ConvertFrom-SecureString $secure
    Write-Utf8NoBom -Path $tokenPath -Text ($encrypted + "`n")
}

function Update-DuckDns {
    param([string]$DomainName, [string]$WanIp)
    $token = Get-DuckDnsToken
    try {
        $subdomain = $DomainName -replace '\.duckdns\.org$', ''
        $url = "https://www.duckdns.org/update?domains=$([uri]::EscapeDataString($subdomain))&token=$([uri]::EscapeDataString($token))&ip=$([uri]::EscapeDataString($WanIp))"
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 10
        } catch {
            throw "DuckDNS update failed."
        }
        if (([string]$response.Content).Trim().ToUpperInvariant() -ne "OK") { throw "DuckDNS rejected the update." }
    } finally {
        $token = $null
    }
}

function Write-CaddyConfig {
    param([string]$DomainName, [int]$UpstreamPort, [string]$Path)
    $text = @"
$DomainName {
    route {
        @public path /healthz /mcp /.well-known/oauth-protected-resource/mcp /.well-known/oauth-authorization-server /authorize /token /register /revoke /mcp-app-assets/*

        handle @public {
            reverse_proxy 127.0.0.1:$UpstreamPort {
                header_up Host 127.0.0.1
            }
        }

        # Browser Control, Chat Swarm HTTP bridges, and Stable Gateway control
        # endpoints are intentionally never part of the public allowlist.
        @private path /browser-control/* /chat-swarm/* /__devspace/*
        handle @private {
            respond "Not Found" 404
        }

        handle {
            respond "Not Found" 404
        }
    }
}
"@
    Write-Utf8NoBom -Path $Path -Text $text
}

function Ensure-FirewallRule {
    param([string]$Alias)
    if (-not (Test-Administrator)) { throw "Install/remove must run from an elevated PowerShell because Windows Firewall is modified." }
    Get-NetFirewallRule -DisplayName $firewallName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule `
        -DisplayName $firewallName `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort 80,443 `
        -InterfaceAlias $Alias `
        -Profile Any | Out-Null
}

function Get-CaddyListener {
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 80,443 })
    if ($listeners.Count -eq 0) { return $null }
    $pids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($pidValue in $pids) {
        $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
        if ($process -and $process.ProcessName -ieq "caddy") {
            return [pscustomobject]@{ Pid = $pidValue; Ports = @($listeners | Where-Object { $_.OwningProcess -eq $pidValue } | Select-Object -ExpandProperty LocalPort -Unique) }
        }
    }
    throw "TCP 80/443 is occupied by a non-Caddy process."
}

function Start-Caddy {
    param($Config)
    if ($script:caddyProcess -and -not $script:caddyProcess.HasExited) { return $script:caddyProcess.Id }
    $existing = Get-CaddyListener
    if ($existing) { return $existing.Pid }
    New-Item -ItemType Directory -Force $logDir | Out-Null
    $outLog = Join-Path $logDir "caddy.out.log"
    $errLog = Join-Path $logDir "caddy.err.log"
    $script:caddyProcess = Start-Process `
        -FilePath ([string]$Config.CaddyPath) `
        -ArgumentList @("run", "--config", [string]$Config.CaddyfilePath, "--adapter", "caddyfile") `
        -WindowStyle Hidden `
        -RedirectStandardOutput $outLog `
        -RedirectStandardError $errLog `
        -PassThru
    Start-Sleep -Seconds 2
    if ($script:caddyProcess.HasExited) { throw "Managed Caddy exited during startup. See $errLog" }
    return $script:caddyProcess.Id
}

function Write-RuntimeStatus {
    param([bool]$Ok, $Config, $Lan, [string]$WanIp, $Mappings, [int]$CaddyPid, [string]$ErrorText = $null)
    $payload = [ordered]@{
        observedAt = (Get-Date).ToUniversalTime().ToString("o")
        ok = $Ok
        domain = [string]$Config.Domain
        interfaceAlias = [string]$Config.InterfaceAlias
        localIPv4 = if ($Lan) { [string]$Lan.LocalIPv4 } else { $null }
        gateway = if ($Lan) { [string]$Lan.Gateway } else { $null }
        wanIPv4 = if ($WanIp) { $WanIp } else { $null }
        mappings = $Mappings
        caddyPid = if ($CaddyPid -gt 0) { $CaddyPid } else { $null }
        error = $ErrorText
        secretValuesLogged = $false
    }
    Write-JsonFile -Path $statusPath -Value $payload
}

function Invoke-RefreshOnce {
    param($Config, [string]$PreviousWanIp = $null, [switch]$ForceDuckDns)
    $lan = Get-LanInfo -Alias ([string]$Config.InterfaceAlias)
    $service = Get-UpnpWanService -Gateway $lan.Gateway
    $wanIp = Get-RouterWanIp -Service $service
    $mappings = @(
        Ensure-PortMapping -Service $service -Port 80 -LocalIPv4 $lan.LocalIPv4
        Ensure-PortMapping -Service $service -Port 443 -LocalIPv4 $lan.LocalIPv4
    )
    if ($ForceDuckDns -or -not $PreviousWanIp -or $PreviousWanIp -ne $wanIp) {
        Update-DuckDns -DomainName ([string]$Config.Domain) -WanIp $wanIp
    }
    $caddyPid = Start-Caddy -Config $Config
    Write-RuntimeStatus -Ok $true -Config $Config -Lan $lan -WanIp $wanIp -Mappings $mappings -CaddyPid $caddyPid
    return [pscustomobject]@{ Lan = $lan; WanIp = $wanIp; Mappings = $mappings; CaddyPid = $caddyPid }
}

function Install-Task {
    param($Config)
    if (-not (Test-Administrator)) { throw "Install must run from an elevated PowerShell." }
    $powershell = Join-Path $PSHOME "powershell.exe"
    $quotedScript = '"{0}"' -f $scriptPath
    $quotedState = '"{0}"' -f $StateDir
    $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -ExecutionPolicy Bypass -File $quotedScript -Action run -StateDir $quotedState"
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $taskAction `
        -Trigger $trigger `
        -Settings $settings `
        -Description "Keep DevSpace self-hosted DuckDNS/Caddy ingress healthy without a request-quota tunnel provider." `
        -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
}

switch ($Action) {
    "install" {
        if (-not (Test-Administrator)) { throw "Run the install action from an elevated PowerShell." }
        $normalizedDomain = Normalize-Domain $Domain
        if (-not $InterfaceAlias) { $InterfaceAlias = Get-DefaultInterfaceAlias }
        if ($GatewayPort -lt 1 -or $GatewayPort -gt 65535) { throw "GatewayPort is invalid." }
        New-Item -ItemType Directory -Force $StateDir | Out-Null
        New-Item -ItemType Directory -Force $logDir | Out-Null
        $caddyCommand = Get-Command caddy -ErrorAction Stop
        $caddyPath = [string]$caddyCommand.Source
        $caddyfilePath = Join-Path $env:USERPROFILE "DevSpaceIngress\Caddyfile"
        if ($RotateToken -or -not (Test-Path -LiteralPath $tokenPath)) { Save-DuckDnsToken }
        Write-CaddyConfig -DomainName $normalizedDomain -UpstreamPort $GatewayPort -Path $caddyfilePath
        & $caddyPath validate --config $caddyfilePath --adapter caddyfile | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Generated Caddy configuration did not validate." }
        $config = [ordered]@{
            schemaVersion = 1
            domain = $normalizedDomain
            interfaceAlias = $InterfaceAlias
            gatewayPort = $GatewayPort
            caddyPath = $caddyPath
            caddyfilePath = $caddyfilePath
            installedAt = (Get-Date).ToUniversalTime().ToString("o")
        }
        Write-JsonFile -Path $configPath -Value $config
        Ensure-FirewallRule -Alias $InterfaceAlias
        $null = Invoke-RefreshOnce -Config $config -ForceDuckDns
        Install-Task -Config $config
        Start-Sleep -Seconds 2
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        [ordered]@{
            ok = $true
            state = "installed"
            taskName = $taskName
            taskState = if ($task) { $task.State.ToString() } else { $null }
            domain = $normalizedDomain
            stateDir = $StateDir
            secretValuesLogged = $false
        } | ConvertTo-Json -Compress
    }
    "refresh" {
        $config = Read-Config
        $result = Invoke-RefreshOnce -Config $config -ForceDuckDns
        [ordered]@{
            ok = $true
            state = "refreshed"
            domain = [string]$config.Domain
            localIPv4 = [string]$result.Lan.LocalIPv4
            wanIPv4 = [string]$result.WanIp
            caddyPid = $result.CaddyPid
            secretValuesLogged = $false
        } | ConvertTo-Json -Compress
    }
    "run" {
        $config = Read-Config
        $lastWanIp = $null
        while ($true) {
            try {
                $result = Invoke-RefreshOnce -Config $config -PreviousWanIp $lastWanIp
                $lastWanIp = [string]$result.WanIp
                Start-Sleep -Seconds 60
            } catch {
                Write-RuntimeStatus -Ok $false -Config $config -Lan $null -WanIp $lastWanIp -Mappings @() -CaddyPid 0 -ErrorText ($_.Exception.Message)
                Start-Sleep -Seconds 30
            }
        }
    }
    "status" {
        $config = $null
        if (Test-Path -LiteralPath $configPath) { $config = Read-Config }
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        $runtime = $null
        if (Test-Path -LiteralPath $statusPath) {
            try { $runtime = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json } catch {}
        }
        [ordered]@{
            ok = [bool]$config
            state = if ($config) { "configured" } else { "not-configured" }
            taskName = $taskName
            taskState = if ($task) { $task.State.ToString() } else { $null }
            domain = if ($config) { [string]$config.Domain } else { $null }
            interfaceAlias = if ($config) { [string]$config.InterfaceAlias } else { $null }
            runtime = $runtime
            tokenProtected = Test-Path -LiteralPath $tokenPath
            secretValuesLogged = $false
        } | ConvertTo-Json -Depth 8 -Compress
    }
    "remove" {
        if (-not (Test-Administrator)) { throw "Run the remove action from an elevated PowerShell." }
        $config = $null
        if (Test-Path -LiteralPath $configPath) { $config = Read-Config }
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($task) {
            if ($task.State -eq "Running") { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }
        if ($config) {
            try {
                $lan = Get-LanInfo -Alias ([string]$config.InterfaceAlias)
                $service = Get-UpnpWanService -Gateway $lan.Gateway
                foreach ($port in 80,443) {
                    $mapping = Get-PortMapping -Service $service -Port $port
                    if ($mapping -and $mapping.Description -eq "DevSpace-Caddy-$port") {
                        Remove-PortMapping -Service $service -Port $port
                    }
                }
            } catch {}
        }
        Get-NetFirewallRule -DisplayName $firewallName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
        [ordered]@{ ok = $true; state = "removed"; taskName = $taskName; stateDirPreserved = $true; secretValuesLogged = $false } | ConvertTo-Json -Compress
    }
}
