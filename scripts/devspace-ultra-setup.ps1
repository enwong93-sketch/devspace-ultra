[CmdletBinding()]
param(
    [ValidateSet("duckdns", "cloudflare", "local")]
    [string]$Edge = "duckdns",
    [string]$Domain,
    [string]$InterfaceAlias,
    [ValidateRange(1024, 65535)]
    [int]$GatewayPort = 7678,
    [string]$ConfigDir = (Join-Path $env:USERPROFILE ".devspace"),
    [string]$PackageRoot = (Split-Path $PSScriptRoot -Parent),
    [string]$WorkerName = "devspace-ultra-mcp-edge"
)

$ErrorActionPreference = "Stop"
$stableGatewayScript = Join-Path $PackageRoot "scripts\devspace-stable-gateway-startup.ps1"
$localIngressScript = Join-Path $PackageRoot "scripts\devspace-local-ingress.ps1"
$cliPath = Join-Path $PackageRoot "dist\cli.js"

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Quote-ProcessArgument {
    param([string]$Value)
    if ($null -eq $Value) { return '""' }
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Restart-Elevated {
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", (Quote-ProcessArgument $PSCommandPath),
        "-Edge", (Quote-ProcessArgument $Edge),
        "-GatewayPort", [string]$GatewayPort,
        "-ConfigDir", (Quote-ProcessArgument $ConfigDir),
        "-PackageRoot", (Quote-ProcessArgument $PackageRoot),
        "-WorkerName", (Quote-ProcessArgument $WorkerName)
    )
    if ($Domain) { $arguments += @("-Domain", (Quote-ProcessArgument $Domain)) }
    if ($InterfaceAlias) { $arguments += @("-InterfaceAlias", (Quote-ProcessArgument $InterfaceAlias)) }
    $process = Start-Process `
        -FilePath (Join-Path $PSHOME "powershell.exe") `
        -ArgumentList ($arguments -join " ") `
        -Verb RunAs `
        -Wait `
        -PassThru
    if ($process.ExitCode -ne 0) {
        throw "Elevated DevSpace setup failed with exit code $($process.ExitCode)."
    }
}

function Refresh-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ";"
}

function Require-Command {
    param([string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) { throw "Required command is unavailable: $Name" }
    return $command
}

function Ensure-WingetPackage {
    param(
        [string]$Command,
        [string]$PackageId,
        [string]$Label
    )
    if (Get-Command $Command -ErrorAction SilentlyContinue) { return }
    $winget = Require-Command "winget"
    Write-Host "Installing $Label..." -ForegroundColor Cyan
    & $winget.Source install `
        --id $PackageId `
        --exact `
        --silent `
        --accept-package-agreements `
        --accept-source-agreements `
        --disable-interactivity
    if ($LASTEXITCODE -ne 0) {
        throw "winget could not install $Label ($PackageId)."
    }
    Refresh-ProcessPath
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        throw "$Label was installed but $Command is not available on PATH. Open a new terminal and rerun devspace-ultra setup."
    }
}

function Ensure-Wrangler {
    if (Get-Command wrangler -ErrorAction SilentlyContinue) { return }
    $npm = Require-Command "npm"
    Write-Host "Installing Cloudflare Wrangler..." -ForegroundColor Cyan
    & $npm.Source install -g wrangler
    if ($LASTEXITCODE -ne 0) { throw "npm could not install Wrangler." }
    Refresh-ProcessPath
    if (-not (Get-Command wrangler -ErrorAction SilentlyContinue)) {
        throw "Wrangler was installed but is not available on PATH."
    }
}

if ($env:OS -ne "Windows_NT") {
    throw "The integrated Stable Gateway + DuckDNS/Cloudflare setup is currently Windows-only."
}

foreach ($required in @($stableGatewayScript, $localIngressScript, $cliPath)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Required setup component is missing: $required" }
}

if (-not (Test-Administrator)) {
    Write-Host "DevSpace setup needs one Windows administrator approval for Scheduled Tasks, firewall rules, and ingress." -ForegroundColor Yellow
    Restart-Elevated
    return
}

$node = Require-Command "node"
Write-Host "Installing the stable Local Gateway service..." -ForegroundColor Cyan
& $stableGatewayScript -Action install -ConfigDir $ConfigDir
if ($LASTEXITCODE -ne 0) { throw "Stable Gateway installation failed." }

$publicBaseUrl = "http://127.0.0.1:$GatewayPort"
$edgeState = "local-only"

switch ($Edge) {
    "duckdns" {
        if (-not $Domain) { throw "DuckDNS setup requires -Domain <name.duckdns.org>." }
        Ensure-WingetPackage -Command "caddy" -PackageId "CaddyServer.Caddy" -Label "Caddy"
        Write-Host "Configuring DuckDNS, Caddy HTTPS, Windows Firewall, and router port mappings..." -ForegroundColor Cyan
        $ingressArguments = @{
            Action = "install"
            Domain = $Domain
            GatewayPort = $GatewayPort
        }
        if ($InterfaceAlias) { $ingressArguments.InterfaceAlias = $InterfaceAlias }
        & $localIngressScript @ingressArguments
        if ($LASTEXITCODE -ne 0) { throw "DuckDNS/Caddy ingress setup failed." }
        $publicBaseUrl = "https://$($Domain.Trim().ToLowerInvariant())"
        $edgeState = "duckdns-caddy"
    }
    "cloudflare" {
        Ensure-WingetPackage -Command "cloudflared" -PackageId "Cloudflare.cloudflared" -Label "Cloudflare Tunnel"
        Ensure-Wrangler
        $wrangler = Require-Command "wrangler"
        & $wrangler.Source whoami *> $null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Cloudflare login is required once. A browser window may open." -ForegroundColor Yellow
            & $wrangler.Source login
            if ($LASTEXITCODE -ne 0) { throw "Cloudflare Wrangler login failed." }
        }
        $previousConfigDir = $env:DEVSPACE_CONFIG_DIR
        try {
            $env:DEVSPACE_CONFIG_DIR = $ConfigDir
            & $node.Source $cliPath edge cloudflare setup --name $WorkerName
            if ($LASTEXITCODE -ne 0) { throw "Cloudflare edge setup failed." }
            $edgeState = "cloudflare-worker-vpc"
        }
        finally {
            if ($null -eq $previousConfigDir) { Remove-Item Env:DEVSPACE_CONFIG_DIR -ErrorAction SilentlyContinue }
            else { $env:DEVSPACE_CONFIG_DIR = $previousConfigDir }
        }
    }
    "local" {
        $edgeState = "local-only"
    }
}

$health = Invoke-RestMethod "http://127.0.0.1:$GatewayPort/healthz"
if ($health.ok -ne $true) { throw "Stable Gateway health verification failed." }

[ordered]@{
    ok = $true
    state = "configured"
    edge = $edgeState
    publicBaseUrl = $publicBaseUrl
    localGateway = "http://127.0.0.1:$GatewayPort"
    configDir = $ConfigDir
    stableGatewayTask = "DevSpace-Stable-Gateway"
    ingressTask = if ($Edge -eq "duckdns") { "DevSpace-Local-Ingress" } else { $null }
    cloudflareFreePlanNotice = if ($Edge -eq "cloudflare") { "Workers Free currently allows 100,000 requests per day; verify current Cloudflare limits before production use." } else { $null }
    secretValuesLogged = $false
} | ConvertTo-Json -Depth 6
