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
    param([switch] $AllowMissing)
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
    if ($AllowMissing) { return $null }
    throw "DevSpace Ultra was installed, but its package directory could not be located."
}

function Invoke-LatestStableUpdater {
    $api = "https://api.github.com/repos/enwong93-sketch/devspace-ultra/releases/latest"
    $headers = @{ "User-Agent" = "DevSpace-Ultra-Installer"; "Accept" = "application/vnd.github+json" }
    $release = Invoke-RestMethod -Uri $api -Headers $headers -Method Get -UseBasicParsing
    if (-not $release -or $release.draft -eq $true -or $release.prerelease -eq $true) {
        throw "GitHub did not return a stable DevSpace Ultra release for the upgrade bootstrap."
    }
    $asset = @($release.assets | Where-Object { [string]$_.name -eq "update.ps1" } | Select-Object -First 1)
    if ($asset.Count -eq 0) {
        throw "The latest stable DevSpace Ultra release does not contain update.ps1."
    }
    $asset = $asset[0]
    $expected = ([string]$asset.digest).ToLowerInvariant() -replace '^sha256:', ''
    if ($expected -notmatch '^[0-9a-f]{64}$') {
        throw "The latest update.ps1 asset does not expose a valid SHA-256 digest."
    }
    $temporary = Join-Path $env:TEMP ("devspace-ultra-update-" + [guid]::NewGuid().ToString('N') + ".ps1")
    try {
        Invoke-WebRequest -Uri ([string]$asset.browser_download_url) -Headers $headers -OutFile $temporary -UseBasicParsing
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $temporary).Hash.ToLowerInvariant()
        if ($actual -ne $expected) { throw "Downloaded update.ps1 failed SHA-256 verification." }
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $temporary -Action apply
        if ($LASTEXITCODE -ne 0) { throw "DevSpace Ultra transactional updater exited with code $LASTEXITCODE." }
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

if ($env:OS -ne "Windows_NT") {
    throw "This installer currently targets Windows because ChatGPT Classic runtime management and Scheduled Tasks are Windows-specific."
}

Write-Step "Checking prerequisites"
Ensure-Node
Ensure-Git

$existingPackageRoot = Find-InstalledPackageRoot -AllowMissing
if ($existingPackageRoot -and $Repository -eq "https://github.com/enwong93-sketch/devspace-ultra.git") {
    Write-Step "Upgrading the existing DevSpace Ultra installation transactionally"
    Invoke-LatestStableUpdater
    $packageRoot = Find-InstalledPackageRoot
}
else {
    Write-Step "Installing DevSpace Ultra from GitHub"
    $source = if ($Ref) { "$Repository#$Ref" } else { $Repository }
    & npm install --global $source --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm installation failed with exit code $LASTEXITCODE." }
    $packageRoot = Find-InstalledPackageRoot
}
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

$updater = Join-Path $packageRoot "update.ps1"
if (-not (Test-Path -LiteralPath $updater)) {
    throw "Installed package is missing update.ps1."
}
Write-Step "Enabling safe automatic stable updates"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $updater -Action install-task
if ($LASTEXITCODE -ne 0) {
    Write-Warning "DevSpace Ultra installed, but the automatic update task could not be enabled. You can retry later with: devspace update --install-task"
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
