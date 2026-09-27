[CmdletBinding()]
param(
    [ValidateSet("DuckDNS", "Cloudflare", "Local")]
    [string] $Network = "DuckDNS",

    [string] $DuckDnsDomain = $env:DEVSPACE_DUCKDNS_DOMAIN,
    [string] $PublicHostname = $env:DEVSPACE_PUBLIC_HOSTNAME,
    [string] $AllowedRoot = $HOME,
    [string] $Repository = "https://github.com/enwong93-sketch/devspace-ultra.git",
    [string] $Ref = "v0.5.11",
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

function Select-ReleaseArchiveAsset {
    param($Release, [string]$Tag)
    if ($Tag -notmatch '^v(\d+\.\d+\.\d+)$') { throw "An exact stable release tag is required: $Tag" }
    $version = $Matches[1]
    if (-not $Release -or [string]$Release.tag_name -ne $Tag -or
        $Release.draft -eq $true -or $Release.prerelease -eq $true) {
        throw "GitHub did not return the exact stable DevSpace Ultra release $Tag."
    }
    $name = "devspace-ultra-$version.tgz"
    $assets = @($Release.assets | Where-Object { [string]$_.name -eq $name })
    if ($assets.Count -ne 1) { throw "Release $Tag must contain exactly one $name archive." }
    $asset = $assets[0]
    $digest = ([string]$asset.digest).ToLowerInvariant() -replace '^sha256:', ''
    if ($digest -notmatch '^[0-9a-f]{64}$') { throw "Release $Tag archive has no valid SHA-256 digest." }
    $url = [string]$asset.browser_download_url
    $expectedPrefix = "https://github.com/enwong93-sketch/devspace-ultra/releases/download/$Tag/"
    if (-not $url.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $url.EndsWith("/$name", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Release $Tag archive URL is outside the expected repository and tag."
    }
    return [pscustomobject]@{ Name=$name; Version=$version; Digest=$digest; Url=$url }
}

function Install-VerifiedReleaseArchive {
    param([string]$Tag)
    $headers = @{ "User-Agent" = "DevSpace-Ultra-Installer"; "Accept" = "application/vnd.github+json" }
    $api = "https://api.github.com/repos/enwong93-sketch/devspace-ultra/releases/tags/$Tag"
    $release = Invoke-RestMethod -Uri $api -Headers $headers -Method Get -UseBasicParsing
    $asset = Select-ReleaseArchiveAsset -Release $release -Tag $Tag
    $temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("devspace-ultra-install-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporary -ErrorAction Stop | Out-Null
    $archive = Join-Path $temporary $asset.Name
    try {
        Invoke-WebRequest -Uri $asset.Url -Headers $headers -OutFile $archive -UseBasicParsing
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
        if ($actual -ne $asset.Digest) { throw "Downloaded $Tag archive failed SHA-256 verification." }
        & npm install --global $archive --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "Release archive installation failed with exit code $LASTEXITCODE." }
        $root = Join-Path ((& npm root --global).Trim()) 'devspace-ultra'
        $manifestPath = Join-Path $root 'package.json'
        if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Release installation is incomplete: package.json is missing." }
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ($manifest.name -ne 'devspace-ultra' -or $manifest.version -ne $asset.Version -or
            -not (Test-Path -LiteralPath (Join-Path $root 'dist\cli.js'))) {
            throw "Release installation did not produce the exact package/CLI for $Tag."
        }
        return $root
    }
    finally {
        if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue }
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
}

function Assert-NativeSqliteBinding {
    param([string]$PackageRoot)
    Write-Step "Rebuilding and verifying the native SQLite dependency"
    & npm rebuild better-sqlite3 --prefix $PackageRoot --ignore-scripts=false --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "better-sqlite3 rebuild failed with exit code $LASTEXITCODE." }
    $modulePath = Join-Path $PackageRoot 'node_modules\better-sqlite3'
    if (-not (Test-Path -LiteralPath (Join-Path $modulePath 'package.json'))) {
        throw "Required better-sqlite3 dependency is missing from the installed package."
    }
    $smoke = "const DB=require(process.argv[1]);const db=new DB(':memory:');db.close();"
    & node -e $smoke $modulePath
    if ($LASTEXITCODE -ne 0) { throw "better-sqlite3 native binding did not load under the installed Node.js runtime." }
}

if ($MyInvocation.InvocationName -eq '.') { return }

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
    if ($Repository -ne "https://github.com/enwong93-sketch/devspace-ultra.git") {
        throw "The stable Windows installer supports only the official digest-verified GitHub Release. Use a separate developer checkout for a custom repository."
    }
    Write-Step "Installing the verified DevSpace Ultra release archive"
    $packageRoot = Install-VerifiedReleaseArchive -Tag $Ref
    Assert-NativeSqliteBinding -PackageRoot $packageRoot
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
if ($EnableRouterUpnp) { $arguments += "-EnableRouterUpnp" }
if ($ManualPortForward) { $arguments += "-ManualPortForward" }
if ($PublicWanIPv4) { $arguments += @("-PublicWanIPv4", (Quote-NativeArgument $PublicWanIPv4)) }
if ($MigrateLegacyIngress) { $arguments += "-MigrateLegacyIngress" }

$process = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList ($arguments -join " ")
if ($process.ExitCode -ne 0) { throw "DevSpace Ultra setup exited with code $($process.ExitCode)." }

Write-Host "`nDevSpace Ultra local setup finished; public ChatGPT Connector acceptance is still required." -ForegroundColor Yellow
Write-Host "Network route: $Network"
Write-Host "Package root: $packageRoot"
Write-Host "Re-run this same tagged command to upgrade or reconcile the installation."
