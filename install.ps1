[CmdletBinding()]
param(
    [ValidateSet("DuckDNS", "Cloudflare", "Local")]
    [string] $Network = "DuckDNS",

    [string] $DuckDnsDomain = $env:DEVSPACE_DUCKDNS_DOMAIN,
    [string] $PublicHostname = $env:DEVSPACE_PUBLIC_HOSTNAME,
    [string] $AllowedRoot = $HOME,
    [string] $Repository = "https://github.com/enwong93-sketch/devspace-ultra.git",
    [string] $Ref = "v0.5.8",
    [switch] $NonInteractive,
    [switch] $SkipCaddy
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step([string] $Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Get-NodeVersion {
    $command = Get-Command node -ErrorAction SilentlyContinue
    if (-not $command) { return $null }
    try { return [version]((& node -p "process.versions.node").Trim()) }
    catch { return $null }
}

function Ensure-Winget {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw "winget is required to install missing Node.js or Git. Install Microsoft App Installer, then run this command again."
    }
}

function Ensure-Node {
    $version = Get-NodeVersion
    if ($version -and $version -ge [version]"22.19.0" -and $version -lt [version]"27.0.0") {
        Write-Host "Node.js $version is compatible."
        return
    }
    Ensure-Winget
    Write-Step "Installing a supported Node.js LTS release"
    & winget.exe install --exact --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "Node.js installation failed with exit code $LASTEXITCODE." }
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
    $version = Get-NodeVersion
    if (-not $version -or $version -lt [version]"22.19.0" -or $version -ge [version]"27.0.0") {
        throw "A compatible Node.js executable is still unavailable after installation."
    }
}

function Ensure-Git {
    if (Get-Command git.exe -ErrorAction SilentlyContinue) { return }
    Ensure-Winget
    Write-Step "Installing Git"
    & winget.exe install --exact --id Git.Git --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "Git installation failed with exit code $LASTEXITCODE." }
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"
}

function Find-InstalledPackageRoot {
    $globalRoot = (& npm root --global).Trim()
    $candidates = @(
        (Join-Path $globalRoot "devspace-ultra"),
        (Join-Path $globalRoot "@waishnav\devspace")
    )
    foreach ($candidate in $candidates) {
        $manifest = Join-Path $candidate "package.json"
        if (-not (Test-Path -LiteralPath $manifest)) { continue }
        try {
            $package = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
            if ($package.name -in @("devspace-ultra", "@waishnav/devspace")) { return $candidate }
        }
        catch {}
    }
    $match = Get-ChildItem -LiteralPath $globalRoot -Filter package.json -File -Recurse -Depth 3 -ErrorAction SilentlyContinue |
        Where-Object {
            try {
                $package = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
                return $package.name -in @("devspace-ultra", "@waishnav/devspace")
            }
            catch { return $false }
        } |
        Select-Object -First 1
    if ($match) { return Split-Path -Parent $match.FullName }
    throw "DevSpace Ultra was installed, but its package directory could not be located."
}

if ($env:OS -ne "Windows_NT") {
    throw "This installer currently targets Windows because ChatGPT Classic runtime management and Scheduled Tasks are Windows-specific."
}

Write-Step "Checking prerequisites"
Ensure-Node
Ensure-Git

Write-Step "Installing DevSpace Ultra from GitHub"
$source = if ($Ref) { "$Repository#$Ref" } else { $Repository }
& npm install --global $source --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm installation failed with exit code $LASTEXITCODE." }

$packageRoot = Find-InstalledPackageRoot
$setupScript = Join-Path $packageRoot "scripts\devspace-public-setup.ps1"
if (-not (Test-Path -LiteralPath $setupScript)) {
    throw "Installed package is missing scripts\devspace-public-setup.ps1."
}

$skillInstaller = Join-Path $packageRoot "install-skill.ps1"
if (-not (Test-Path -LiteralPath $skillInstaller)) {
    throw "Installed package is missing install-skill.ps1."
}

Write-Step "Installing the DevSpace Ultra guided setup Agent Skill"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $skillInstaller -SourceRoot $packageRoot
if ($LASTEXITCODE -ne 0) {
    throw "Agent Skill installation failed with exit code $LASTEXITCODE."
}

Write-Step "Configuring Local Gateway and public ingress"
function Quote-NativeArgument([string] $Value) {
    if ($Value.Contains('"')) { throw "A setup argument contains an unsupported quote character." }
    return '"' + $Value + '"'
}

$arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", (Quote-NativeArgument $setupScript),
    "-Network", $Network,
    "-AllowedRoot", (Quote-NativeArgument $AllowedRoot)
)
if ($DuckDnsDomain) { $arguments += @("-DuckDnsDomain", (Quote-NativeArgument $DuckDnsDomain)) }
if ($PublicHostname) { $arguments += @("-PublicHostname", (Quote-NativeArgument $PublicHostname)) }
if ($NonInteractive) { $arguments += "-NonInteractive" }
if ($SkipCaddy) { $arguments += "-SkipCaddy" }

$process = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList ($arguments -join " ")
if ($process.ExitCode -ne 0) { throw "DevSpace Ultra setup exited with code $($process.ExitCode)." }

Write-Host "`nDevSpace Ultra setup completed." -ForegroundColor Green
Write-Host "Network route: $Network"
Write-Host "Package root: $packageRoot"
Write-Host "Re-run this same tagged command to upgrade or reconcile the installation."
