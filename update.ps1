[CmdletBinding()]
param(
    [ValidateSet("apply", "check", "status", "install-task", "remove-task")]
    [string] $Action = "apply",

    [string] $Repository = "enwong93-sketch/devspace-ultra",
    [string] $ReleaseApiUrl,
    [string] $PackageArchive,
    [string] $TargetVersion,
    [string] $TargetTag,
    [string] $ExpectedSha256,
    [string] $NpmPrefix,
    [string] $BackupRoot,
    [string] $UpdaterStateRoot,
    [switch] $Automatic,
    [switch] $Quiet,
    [switch] $Force,
    [switch] $SkipRuntimeRestart,
    [switch] $NoAutoUpdateTask,
    [int] $WaitForProcessId = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ($env:OS -ne "Windows_NT") {
    throw "The transactional DevSpace Ultra updater currently targets Windows. On macOS/Linux use the documented npm update path."
}

$script:UpdaterSchemaVersion = 1
$script:TestMode = $env:DEVSPACE_UPDATE_TEST_MODE -eq "1"
$script:AutoTaskName = "DevSpace-Ultra-Auto-Update"
$script:KnownPackageNames = @("devspace-ultra", "@waishnav/devspace")
$script:KnownShimNames = @(
    "devspace", "devspace.cmd", "devspace.ps1",
    "devspace-ultra", "devspace-ultra.cmd", "devspace-ultra.ps1",
    "devspace-conversation-bridge", "devspace-conversation-bridge.cmd", "devspace-conversation-bridge.ps1"
)
$script:KnownRuntimeTasks = @(
    "DevSpace-Stable-Gateway",
    "DevSpace-Fixed-Backend",
    "DevSpace-Local-Ingress",
    "DevSpace-Live-Progress-Overlay",
    "DevSpace-Canonical-Startup"
)
$script:UpdaterStateRoot = if ($UpdaterStateRoot) { [IO.Path]::GetFullPath($UpdaterStateRoot) } else { Join-Path $env:LOCALAPPDATA "DevSpaceUltra\Updater" }
$script:CurrentStatePath = Join-Path $script:UpdaterStateRoot "current.json"
$script:LastStatusPath = Join-Path $script:UpdaterStateRoot "last-update.json"

function Write-Info([string] $Message, [ConsoleColor] $Color = [ConsoleColor]::Gray) {
    if (-not $Quiet) { Write-Host $Message -ForegroundColor $Color }
}

function Write-AtomicJson([string] $Path, $Value) {
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temporary -Encoding utf8
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Write-UpdateStatus([string] $State, $Extra = @{}) {
    $payload = [ordered]@{
        schemaVersion = $script:UpdaterSchemaVersion
        observedAt = (Get-Date).ToUniversalTime().ToString("o")
        state = $State
        automatic = [bool]$Automatic
        secretValuesLogged = $false
    }
    foreach ($entry in $Extra.GetEnumerator()) { $payload[$entry.Key] = $entry.Value }
    Write-AtomicJson -Path $script:LastStatusPath -Value $payload
    return [pscustomobject]$payload
}

function Read-JsonFile([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
    catch { return $null }
}

function Get-NpmPrefixPath {
    if ($NpmPrefix) {
        New-Item -ItemType Directory -Path $NpmPrefix -Force | Out-Null
        return [IO.Path]::GetFullPath($NpmPrefix)
    }
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { $npm = Get-Command npm -ErrorAction Stop }
    $prefix = (& $npm.Source prefix --global).Trim()
    if (-not $prefix) { throw "npm did not return a global prefix." }
    return [IO.Path]::GetFullPath($prefix)
}

function Get-InstalledPackageRecords([string] $Prefix) {
    $globalRoot = Join-Path $Prefix "node_modules"
    $candidates = @(
        (Join-Path $globalRoot "devspace-ultra"),
        (Join-Path $globalRoot "@waishnav\devspace")
    )
    $records = @()
    foreach ($candidate in $candidates) {
        $manifestPath = Join-Path $candidate "package.json"
        if (-not (Test-Path -LiteralPath $manifestPath)) { continue }
        try {
            $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
            if ([string]$manifest.name -notin $script:KnownPackageNames) { continue }
            $records += [pscustomobject]@{
                Name = [string]$manifest.name
                Version = [string]$manifest.version
                Root = [IO.Path]::GetFullPath($candidate)
                ManifestPath = $manifestPath
            }
        }
        catch {}
    }
    return @($records)
}

function Get-PrimaryInstalledRecord([object[]] $Records) {
    $preferred = @($Records | Where-Object { $_.Name -eq "devspace-ultra" } | Select-Object -First 1)
    if ($preferred.Count -gt 0) { return $preferred[0] }
    $legacy = @($Records | Where-Object { $_.Name -eq "@waishnav/devspace" } | Select-Object -First 1)
    if ($legacy.Count -gt 0) { return $legacy[0] }
    return $null
}

function Get-Sha256([string] $Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Normalize-Sha256([string] $Value) {
    $text = ([string]$Value).Trim().ToLowerInvariant()
    if ($text.StartsWith("sha256:")) { $text = $text.Substring(7) }
    if ($text -notmatch '^[0-9a-f]{64}$') { return $null }
    return $text
}

function Get-LatestReleaseInfo {
    if ($PackageArchive) {
        if (-not (Test-Path -LiteralPath $PackageArchive)) { throw "PackageArchive does not exist: $PackageArchive" }
        if (-not $TargetVersion) { throw "TargetVersion is required with PackageArchive." }
        $sha = if ($ExpectedSha256) { Normalize-Sha256 $ExpectedSha256 } else { Get-Sha256 $PackageArchive }
        if (-not $sha) { throw "ExpectedSha256 is invalid." }
        return [pscustomobject]@{
            Version = $TargetVersion.TrimStart('v')
            Tag = $(if ($TargetTag) { $TargetTag } else { "v$($TargetVersion.TrimStart('v'))" })
            ArchiveName = Split-Path -Leaf $PackageArchive
            ArchiveUrl = $null
            ArchiveSha256 = $sha
            LocalArchive = [IO.Path]::GetFullPath($PackageArchive)
            ReleaseUrl = $null
        }
    }

    $api = if ($ReleaseApiUrl) { $ReleaseApiUrl } else { "https://api.github.com/repos/$Repository/releases/latest" }
    $headers = @{
        "User-Agent" = "DevSpace-Ultra-Updater/$script:UpdaterSchemaVersion"
        "Accept" = "application/vnd.github+json"
    }
    $release = Invoke-RestMethod -Uri $api -Headers $headers -Method Get -UseBasicParsing
    if (-not $release -or $release.draft -eq $true -or $release.prerelease -eq $true) {
        throw "GitHub did not return a stable DevSpace Ultra release."
    }
    $tag = [string]$release.tag_name
    if ($tag -notmatch '^v?([0-9]+\.[0-9]+\.[0-9]+)$') { throw "Latest release tag is not a stable semantic version: $tag" }
    $version = $Matches[1]
    $asset = @($release.assets | Where-Object { [string]$_.name -match '^devspace-ultra-[0-9].*\.tgz$' } | Select-Object -First 1)
    if ($asset.Count -eq 0) { throw "Latest release has no devspace-ultra npm archive asset." }
    $asset = $asset[0]
    $sha = Normalize-Sha256 ([string]$asset.digest)
    if (-not $sha) {
        $sumAsset = @($release.assets | Where-Object { [string]$_.name -eq "SHA256SUMS.txt" } | Select-Object -First 1)
        if ($sumAsset.Count -eq 0) { throw "Latest release exposes neither an asset digest nor SHA256SUMS.txt." }
        $sumPath = Join-Path $env:TEMP ("devspace-ultra-sums-" + [guid]::NewGuid().ToString('N') + ".txt")
        try {
            Invoke-WebRequest -Uri ([string]$sumAsset[0].browser_download_url) -Headers $headers -OutFile $sumPath -UseBasicParsing
            $line = Get-Content -LiteralPath $sumPath | Where-Object { $_ -match [regex]::Escape([string]$asset.name) } | Select-Object -First 1
            if (-not $line -or $line -notmatch '([0-9a-fA-F]{64})') { throw "SHA256SUMS.txt has no checksum for $($asset.name)." }
            $sha = $Matches[1].ToLowerInvariant()
        }
        finally { Remove-Item -LiteralPath $sumPath -Force -ErrorAction SilentlyContinue }
    }
    return [pscustomobject]@{
        Version = $version
        Tag = $tag
        ArchiveName = [string]$asset.name
        ArchiveUrl = [string]$asset.browser_download_url
        ArchiveSha256 = $sha
        LocalArchive = $null
        ReleaseUrl = [string]$release.html_url
    }
}

function Compare-StableVersion([string] $Left, [string] $Right) {
    try { return ([version]$Left).CompareTo([version]$Right) }
    catch { throw "Unable to compare versions '$Left' and '$Right'." }
}

function Get-Decision($Installed, $Release) {
    if (-not $Installed) { return "install" }
    $comparison = Compare-StableVersion $Installed.Version $Release.Version
    if ($comparison -lt 0) { return "update" }
    if ($comparison -gt 0) { return $(if ($Force) { "downgrade" } else { "newer-local" }) }
    $state = Read-JsonFile $script:CurrentStatePath
    $knownDigest = if ($state -and $state.PSObject.Properties.Name -contains "archiveSha256") { Normalize-Sha256 ([string]$state.archiveSha256) } else { $null }
    if ($knownDigest -and $knownDigest -eq $Release.ArchiveSha256) { return $(if ($Force) { "repair" } else { "current" }) }
    return "repair"
}

function Get-ProtectedStateFingerprint {
    if ($script:TestMode) { return @{} }
    $paths = @(
        (Join-Path $HOME ".devspace\config.json"),
        (Join-Path $HOME ".devspace\auth.json"),
        (Join-Path $HOME ".devspace-tailscale-bootstrap\config.json"),
        (Join-Path $HOME ".devspace-tailscale-bootstrap\auth.json"),
        (Join-Path $env:LOCALAPPDATA "DevSpace\ChatSwarmClassic\controller-state.json")
    )
    $result = @{}
    foreach ($path in $paths) {
        if (Test-Path -LiteralPath $path -PathType Leaf) { $result[$path] = Get-Sha256 $path }
        else { $result[$path] = $null }
    }
    return $result
}

function Assert-ProtectedStateUnchanged($Before) {
    foreach ($path in $Before.Keys) {
        $after = if (Test-Path -LiteralPath $path -PathType Leaf) { Get-Sha256 $path } else { $null }
        if ($after -ne $Before[$path]) { throw "Updater changed protected user state unexpectedly: $path" }
    }
}

function Get-TaskSnapshot {
    if ($script:TestMode) { return @() }
    $rows = @()
    foreach ($name in $script:KnownRuntimeTasks) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if (-not $task) { continue }
        $rows += [pscustomobject]@{
            Name = $name
            State = $task.State.ToString()
            WasRunning = $task.State.ToString() -eq "Running"
            Actions = @($task.Actions | ForEach-Object {
                [pscustomobject]@{
                    Execute = [string]$_.Execute
                    Arguments = [string]$_.Arguments
                    WorkingDirectory = [string]$_.WorkingDirectory
                }
            })
        }
    }
    return @($rows)
}

function Replace-PathInsensitive([string] $Text, [string] $OldPath, [string] $NewPath) {
    if ([string]::IsNullOrEmpty($Text) -or [string]::IsNullOrEmpty($OldPath)) { return $Text }
    return [regex]::Replace(
        $Text,
        [regex]::Escape($OldPath),
        [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $NewPath },
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
}

function Convert-TaskActions([object[]] $ActionRows, [object[]] $PackageRecords, [string] $CanonicalRoot, [switch] $Original) {
    $actions = @()
    foreach ($row in $ActionRows) {
        $execute = [string]$row.Execute
        $arguments = [string]$row.Arguments
        $workingDirectory = [string]$row.WorkingDirectory
        if (-not $Original) {
            foreach ($record in $PackageRecords) {
                $oldRoot = [string]$record.Root
                if (-not $oldRoot -or $oldRoot -eq $CanonicalRoot) { continue }
                $execute = Replace-PathInsensitive $execute $oldRoot $CanonicalRoot
                $arguments = Replace-PathInsensitive $arguments $oldRoot $CanonicalRoot
                $workingDirectory = Replace-PathInsensitive $workingDirectory $oldRoot $CanonicalRoot
            }
        }
        $parameters = @{ Execute = $execute }
        if ($arguments) { $parameters["Argument"] = $arguments }
        if ($workingDirectory) { $parameters["WorkingDirectory"] = $workingDirectory }
        $actions += New-ScheduledTaskAction @parameters
    }
    return @($actions)
}

function Migrate-RuntimeTaskPackagePaths([object[]] $TaskSnapshot, [object[]] $PackageRecords, [string] $CanonicalRoot) {
    if ($script:TestMode) { return }
    foreach ($task in $TaskSnapshot) {
        if (-not $task.Actions -or @($task.Actions).Count -eq 0) { continue }
        $before = @($task.Actions | ForEach-Object { "$( $_.Execute )|$( $_.Arguments )|$( $_.WorkingDirectory )" }) -join "`n"
        $actions = @(Convert-TaskActions -ActionRows @($task.Actions) -PackageRecords $PackageRecords -CanonicalRoot $CanonicalRoot)
        $after = @($actions | ForEach-Object { "$( $_.Execute )|$( $_.Arguments )|$( $_.WorkingDirectory )" }) -join "`n"
        if ($before -eq $after) { continue }
        Set-ScheduledTask -TaskName $task.Name -Action $actions -ErrorAction Stop | Out-Null
    }
}

function Restore-RuntimeTaskActions([object[]] $TaskSnapshot) {
    if ($script:TestMode) { return }
    foreach ($task in $TaskSnapshot) {
        if (-not $task.Actions -or @($task.Actions).Count -eq 0) { continue }
        if (-not (Get-ScheduledTask -TaskName $task.Name -ErrorAction SilentlyContinue)) { continue }
        $actions = @(Convert-TaskActions -ActionRows @($task.Actions) -PackageRecords @() -CanonicalRoot "" -Original)
        Set-ScheduledTask -TaskName $task.Name -Action $actions -ErrorAction Stop | Out-Null
    }
}

function Get-GatewayBusyState {
    if ($script:TestMode) { return [pscustomobject]@{ Known = $true; Busy = $false; HttpActive = 0; ToolActive = 0 } }
    $controlPath = Join-Path $HOME ".devspace-tailscale-bootstrap\logs\stable-gateway-control.json"
    if (-not (Test-Path -LiteralPath $controlPath)) { return [pscustomobject]@{ Known = $false; Busy = $false } }
    try {
        $control = Get-Content -LiteralPath $controlPath -Raw | ConvertFrom-Json
        $port = [int]$control.gatewayPort
        $token = [string]$control.controlToken
        if ($port -lt 1 -or -not $token) { return [pscustomobject]@{ Known = $false; Busy = $false } }
        $headers = @{ "x-devspace-gateway-control" = $token }
        $status = Invoke-RestMethod -Uri "http://127.0.0.1:$port/__devspace/gateway/status" -Headers $headers -Method Get -UseBasicParsing
        $httpActive = if ($status.admission -and $status.admission.PSObject.Properties.Name -contains "activeRequests") { [int]$status.admission.activeRequests } else { 0 }
        $toolActive = if ($status.sessions -and $status.sessions.PSObject.Properties.Name -contains "totalNonStreamActiveRequests") { [int]$status.sessions.totalNonStreamActiveRequests } else { 0 }
        return [pscustomobject]@{ Known = $true; Busy = (($httpActive + $toolActive) -gt 0); HttpActive = $httpActive; ToolActive = $toolActive }
    }
    catch { return [pscustomobject]@{ Known = $false; Busy = $false } }
}

function Stop-DevSpaceRuntime([object[]] $PackageRecords, [object[]] $TaskSnapshot) {
    if ($script:TestMode) { return }
    foreach ($task in $TaskSnapshot) {
        if (-not $task.WasRunning) { continue }
        try { Stop-ScheduledTask -TaskName $task.Name -ErrorAction Stop } catch {}
    }
    Start-Sleep -Milliseconds 600
    $roots = @($PackageRecords | ForEach-Object { [string]$_.Root })
    if ($roots.Count -eq 0) { return }
    $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        if ([int]$_.ProcessId -eq $PID) { return $false }
        $command = [string]$_.CommandLine
        if (-not $command) { return $false }
        $matchesRoot = $false
        foreach ($root in $roots) { if ($command.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $matchesRoot = $true; break } }
        if (-not $matchesRoot) { return $false }
        return $command -match 'devspace-(?:stable-gateway|fixed-backend|local-ingress|live-progress)|dist[\\/]cli\.js\s+serve'
    }
    foreach ($process in $processes) {
        try { Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop } catch {}
    }
    Start-Sleep -Milliseconds 400
}

function Restart-PreviousRuntime([object[]] $TaskSnapshot) {
    if ($script:TestMode) { return }
    if ($SkipRuntimeRestart) { return }
    foreach ($task in $TaskSnapshot) {
        if (-not $task.WasRunning) { continue }
        try {
            if (Get-ScheduledTask -TaskName $task.Name -ErrorAction SilentlyContinue) {
                Start-ScheduledTask -TaskName $task.Name -ErrorAction Stop
            }
        }
        catch {
            Write-Info "Warning: could not restart scheduled task $($task.Name): $($_.Exception.Message)" Yellow
        }
    }
}

function Copy-Shims([string] $SourcePrefix, [string] $TargetPrefix) {
    foreach ($name in $script:KnownShimNames) {
        $source = Join-Path $SourcePrefix $name
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
        $target = Join-Path $TargetPrefix $name
        Copy-Item -LiteralPath $source -Destination $target -Force
    }
}

function Backup-Shims([string] $Prefix, [string] $Directory) {
    New-Item -ItemType Directory -Path $Directory -Force | Out-Null
    $present = @()
    foreach ($name in $script:KnownShimNames) {
        $source = Join-Path $Prefix $name
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
        Copy-Item -LiteralPath $source -Destination (Join-Path $Directory $name) -Force
        $present += $name
    }
    return @($present)
}

function Restore-Shims([string] $Prefix, [string] $Directory, [string[]] $OriginallyPresent) {
    foreach ($name in $script:KnownShimNames) {
        $target = Join-Path $Prefix $name
        if ($OriginallyPresent -contains $name) {
            Copy-Item -LiteralPath (Join-Path $Directory $name) -Destination $target -Force
        }
        else {
            Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
        }
    }
}

function Install-AutoUpdateTask([string] $PackageRoot) {
    if ($script:TestMode) { return $false }
    if ($NoAutoUpdateTask) { return $false }
    $scriptPath = Join-Path $PackageRoot "update.ps1"
    if (-not (Test-Path -LiteralPath $scriptPath)) { throw "Installed package is missing update.ps1." }
    $powershell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
    $arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Action apply -Automatic -Quiet' -f $scriptPath
    $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $PackageRoot
    $trigger = New-ScheduledTaskTrigger -Daily -At 4:00AM -RandomDelay (New-TimeSpan -Minutes 45)
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $script:AutoTaskName -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal -Description "Safely keep DevSpace Ultra on the latest stable GitHub release; defers while active work is in flight and rolls back failed upgrades." -Force | Out-Null
    return $true
}

function Try-InstallAutoUpdateTask([string] $PackageRoot) {
    if ($NoAutoUpdateTask -or $script:TestMode) { return $false }
    try { return [bool](Install-AutoUpdateTask -PackageRoot $PackageRoot) }
    catch {
        Write-Info "Warning: DevSpace Ultra was updated, but the automatic update task could not be enabled: $($_.Exception.Message)" Yellow
        return $false
    }
}

function Remove-AutoUpdateTask {
    if ($script:TestMode) { return }
    if (Get-ScheduledTask -TaskName $script:AutoTaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $script:AutoTaskName -Confirm:$false
    }
}

function Get-AutoUpdateTaskStatus {
    if ($script:TestMode) {
        return [ordered]@{
            installed = $false
            state = "test-isolated"
            taskName = $script:AutoTaskName
        }
    }
    $task = Get-ScheduledTask -TaskName $script:AutoTaskName -ErrorAction SilentlyContinue
    return [ordered]@{
        installed = [bool]$task
        state = if ($task) { $task.State.ToString() } else { $null }
        taskName = $script:AutoTaskName
    }
}

function Invoke-StagePackage($Release, [string] $ArchivePath, [string] $Prefix) {
    $stagePrefix = Join-Path $env:TEMP ("devspace-ultra-stage-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stagePrefix -Force | Out-Null
    $root = Join-Path $stagePrefix "node_modules\devspace-ultra"
    if ($script:TestMode) {
        # Sandbox validation exercises the real npm release archive plus the
        # transactional migration/rollback logic, but it does not need to
        # redownload the dependency graph that the CI workspace already has.
        # Production never enters this branch.
        $extractRoot = Join-Path $stagePrefix "archive-extract"
        New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
        $tar = Get-Command tar.exe -ErrorAction Stop
        & $tar.Source -xf $ArchivePath -C $extractRoot
        if ($LASTEXITCODE -ne 0) { throw "Sandbox archive extraction failed with exit code $LASTEXITCODE." }
        $packageRoot = Join-Path $extractRoot "package"
        if (-not (Test-Path -LiteralPath $packageRoot)) { throw "Sandbox archive did not contain the npm package root." }
        New-Item -ItemType Directory -Path (Split-Path -Parent $root) -Force | Out-Null
        Move-Item -LiteralPath $packageRoot -Destination $root -Force
        Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    else {
        $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if (-not $npm) { $npm = Get-Command npm -ErrorAction Stop }
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            # npm writes deprecation/advisory text to stderr even on a successful
            # install. Under the updater's global Stop policy PowerShell 5 can
            # promote those native stderr records into terminating errors, so keep
            # this one native boundary non-terminating and trust the real exit code.
            $ErrorActionPreference = "Continue"
            $npmOutput = @(& $npm.Source install --global --prefix $stagePrefix $ArchivePath --ignore-scripts --no-audit --no-fund 2>&1)
            $npmExitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($npmExitCode -ne 0) { throw "Staging npm install failed with exit code $npmExitCode." }
        if (-not $Quiet) {
            foreach ($line in $npmOutput) { Write-Host ([string]$line) }
        }
    }
    $manifestPath = Join-Path $root "package.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Staged archive did not install devspace-ultra." }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ([string]$manifest.name -ne "devspace-ultra" -or [string]$manifest.version -ne $Release.Version) {
        throw "Staged package identity/version mismatch."
    }
    foreach ($relative in @("dist\cli.js", "install-skill.ps1", "update.ps1", "scripts\release-version-consistency-gate.mjs")) {
        if (-not (Test-Path -LiteralPath (Join-Path $root $relative))) { throw "Staged package is missing $relative." }
    }
    foreach ($relative in @("dist\cli.js", "dist\server.js", "scripts\devspace-stable-gateway.mjs")) {
        & node --check (Join-Path $root $relative)
        if ($LASTEXITCODE -ne 0) { throw "Staged syntax check failed for $relative." }
    }
    if (-not $script:TestMode) {
        $reportedVersion = ((@(& node (Join-Path $root "dist\cli.js") version) -join "`n").Trim())
        if ($LASTEXITCODE -ne 0 -or $reportedVersion -notmatch [regex]::Escape($Release.Version)) {
            throw "Staged CLI could not report target version $($Release.Version)."
        }
    }
    return [pscustomobject]@{ Prefix = $stagePrefix; Root = $root; Manifest = $manifest }
}

function Prune-OldBackups([string] $Root, [int] $Keep = 3) {
    if (-not (Test-Path -LiteralPath $Root)) { return }
    $directories = @(Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending)
    foreach ($directory in @($directories | Select-Object -Skip $Keep)) {
        Remove-Item -LiteralPath $directory.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($env:DEVSPACE_UPDATE_LIBRARY_ONLY -eq "1") { return }

if ($WaitForProcessId -gt 0 -and $WaitForProcessId -ne $PID) {
    try { Wait-Process -Id $WaitForProcessId -ErrorAction SilentlyContinue } catch {}
}

$prefix = Get-NpmPrefixPath
$globalRoot = Join-Path $prefix "node_modules"
New-Item -ItemType Directory -Path $globalRoot -Force | Out-Null
if (-not $BackupRoot) { $BackupRoot = Join-Path $globalRoot ".devspace-update-backups" }
New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null

if ($Action -eq "status") {
    $records = Get-InstalledPackageRecords -Prefix $prefix
    $installed = Get-PrimaryInstalledRecord $records
    $payload = [ordered]@{
        installedVersion = if ($installed) { $installed.Version } else { $null }
        packageRoot = if ($installed) { $installed.Root } else { $null }
        current = Read-JsonFile $script:CurrentStatePath
        lastUpdate = Read-JsonFile $script:LastStatusPath
        autoUpdate = Get-AutoUpdateTaskStatus
    }
    $payload | ConvertTo-Json -Depth 10
    exit 0
}

if ($Action -eq "remove-task") {
    Remove-AutoUpdateTask
    (Get-AutoUpdateTaskStatus) | ConvertTo-Json -Depth 5
    exit 0
}

if ($Action -eq "install-task") {
    $record = Get-PrimaryInstalledRecord (Get-InstalledPackageRecords -Prefix $prefix)
    if (-not $record -or $record.Name -ne "devspace-ultra") { throw "Install DevSpace Ultra before enabling automatic updates." }
    $null = Install-AutoUpdateTask -PackageRoot $record.Root
    (Get-AutoUpdateTaskStatus) | ConvertTo-Json -Depth 5
    exit 0
}

Write-UpdateStatus -State "checking" -Extra @{} | Out-Null
$release = Get-LatestReleaseInfo
$records = Get-InstalledPackageRecords -Prefix $prefix
$installed = Get-PrimaryInstalledRecord $records
$decision = Get-Decision -Installed $installed -Release $release
$checkPayload = [ordered]@{
    installedVersion = if ($installed) { $installed.Version } else { $null }
    targetVersion = $release.Version
    targetTag = $release.Tag
    decision = $decision
    releaseUrl = $release.ReleaseUrl
}

if ($Action -eq "check") {
    $status = Write-UpdateStatus -State "checked" -Extra $checkPayload
    $status | ConvertTo-Json -Depth 8
    exit 0
}

if ($decision -eq "current") {
    $autoUpdateEnabled = if ($installed) { Try-InstallAutoUpdateTask -PackageRoot $installed.Root } else { $false }
    $checkPayload["autoUpdateEnabled"] = [bool]$autoUpdateEnabled
    $status = Write-UpdateStatus -State "current" -Extra $checkPayload
    Write-Info "DevSpace Ultra $($release.Version) is already current." Green
    if (-not $Quiet) { $status | ConvertTo-Json -Depth 8 }
    exit 0
}
if ($decision -eq "newer-local") {
    $status = Write-UpdateStatus -State "newer-local" -Extra $checkPayload
    Write-Info "Installed DevSpace Ultra $($installed.Version) is newer than GitHub stable $($release.Version); no downgrade was performed." Yellow
    if (-not $Quiet) { $status | ConvertTo-Json -Depth 8 }
    exit 0
}

$busy = Get-GatewayBusyState
if ($busy.Known -and $busy.Busy -and -not $Force) {
    $extra = @{} + $checkPayload
    $extra["reason"] = "active-work"
    $status = Write-UpdateStatus -State $(if ($Automatic) { "deferred" } else { "busy" }) -Extra $extra
    if ($Automatic) { exit 0 }
    throw "DevSpace has active non-stream work. Retry when the current Agent/tool call finishes, or use -Force only if interruption is intentional."
}

$archivePath = $null
$downloadedArchive = $false
$staged = $null
$backupDirectory = $null
$taskSnapshot = @()
$shimBackupDirectory = $null
$shimPresent = @()
$packageBackups = @()
$protectedFingerprint = Get-ProtectedStateFingerprint

try {
    if ($release.LocalArchive) {
        $archivePath = $release.LocalArchive
    }
    else {
        $archivePath = Join-Path $env:TEMP ("devspace-ultra-" + [guid]::NewGuid().ToString('N') + ".tgz")
        Invoke-WebRequest -Uri $release.ArchiveUrl -Headers @{ "User-Agent" = "DevSpace-Ultra-Updater/$script:UpdaterSchemaVersion" } -OutFile $archivePath -UseBasicParsing
        $downloadedArchive = $true
    }
    $actualSha = Get-Sha256 $archivePath
    if ($actualSha -ne $release.ArchiveSha256) { throw "Downloaded archive SHA-256 does not match the GitHub release digest." }

    Write-UpdateStatus -State "staging" -Extra $checkPayload | Out-Null
    $staged = Invoke-StagePackage -Release $release -ArchivePath $archivePath -Prefix $prefix

    $taskSnapshot = Get-TaskSnapshot
    Stop-DevSpaceRuntime -PackageRecords $records -TaskSnapshot $taskSnapshot

    $timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
    $backupDirectory = Join-Path $BackupRoot ("$timestamp-" + $(if ($installed) { $installed.Version } else { "fresh" }))
    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    $shimBackupDirectory = Join-Path $backupDirectory "shims"
    $shimPresent = @(Backup-Shims -Prefix $prefix -Directory $shimBackupDirectory)

    foreach ($record in $records) {
        $safeName = $record.Name -replace '[@/\\]', '_'
        $destination = Join-Path $backupDirectory ("package-" + $safeName)
        Move-Item -LiteralPath $record.Root -Destination $destination -Force
        $packageBackups += [pscustomobject]@{ Original = $record.Root; Backup = $destination }
    }

    $canonicalRoot = Join-Path $globalRoot "devspace-ultra"
    if (Test-Path -LiteralPath $canonicalRoot) { throw "Canonical package root unexpectedly exists after backup: $canonicalRoot" }
    Move-Item -LiteralPath $staged.Root -Destination $canonicalRoot -Force
    Copy-Shims -SourcePrefix $staged.Prefix -TargetPrefix $prefix

    $nodePtyFix = Join-Path $canonicalRoot "scripts\fix-node-pty-permissions.mjs"
    if (Test-Path -LiteralPath $nodePtyFix) {
        & node $nodePtyFix
        if ($LASTEXITCODE -ne 0) { throw "node-pty permission repair failed." }
    }
    if (-not $script:TestMode) {
        $skillInstaller = Join-Path $canonicalRoot "install-skill.ps1"
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $skillInstaller -SourceRoot $canonicalRoot
        if ($LASTEXITCODE -ne 0) { throw "Agent Skill refresh failed." }
    }

    $installedManifest = Get-Content -LiteralPath (Join-Path $canonicalRoot "package.json") -Raw | ConvertFrom-Json
    if ([string]$installedManifest.version -ne $release.Version) { throw "Installed package version did not match the target after swap." }
    if (-not $script:TestMode) {
        & node (Join-Path $canonicalRoot "dist\cli.js") version | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Installed CLI verification failed." }
    }
    Assert-ProtectedStateUnchanged -Before $protectedFingerprint

    if ($script:TestMode -and $env:DEVSPACE_UPDATE_TEST_FAIL_AFTER_SWAP -eq "1") {
        throw "Injected updater verification failure."
    }

    Migrate-RuntimeTaskPackagePaths -TaskSnapshot $taskSnapshot -PackageRecords $records -CanonicalRoot $canonicalRoot
    Restart-PreviousRuntime -TaskSnapshot $taskSnapshot
    $autoUpdateEnabled = Try-InstallAutoUpdateTask -PackageRoot $canonicalRoot

    Write-AtomicJson -Path $script:CurrentStatePath -Value ([ordered]@{
        schemaVersion = $script:UpdaterSchemaVersion
        version = $release.Version
        tag = $release.Tag
        archiveSha256 = $release.ArchiveSha256
        packageRoot = $canonicalRoot
        installedAt = (Get-Date).ToUniversalTime().ToString("o")
    })
    Prune-OldBackups -Root $BackupRoot -Keep 3
    $completionExtra = @{} + $checkPayload
    $completionExtra["previousVersion"] = if ($installed) { $installed.Version } else { $null }
    $completionExtra["installedVersion"] = $release.Version
    $completionExtra["rollbackAvailable"] = [bool]$backupDirectory
    $completionExtra["autoUpdateEnabled"] = [bool]$autoUpdateEnabled
    $status = Write-UpdateStatus -State "completed" -Extra $completionExtra
    Write-Info "DevSpace Ultra is now on stable $($release.Version). Existing config, auth, conversations and runtime profiles were preserved." Green
    if (-not $Quiet) { $status | ConvertTo-Json -Depth 8 }
}
catch {
    $failure = $_
    try {
        $canonicalRoot = Join-Path $globalRoot "devspace-ultra"
        if ($packageBackups.Count -gt 0) {
            if (Test-Path -LiteralPath $canonicalRoot) { Remove-Item -LiteralPath $canonicalRoot -Recurse -Force -ErrorAction SilentlyContinue }
            foreach ($item in $packageBackups) {
                $parent = Split-Path -Parent $item.Original
                New-Item -ItemType Directory -Path $parent -Force | Out-Null
                if (Test-Path -LiteralPath $item.Backup) { Move-Item -LiteralPath $item.Backup -Destination $item.Original -Force }
            }
            if ($shimBackupDirectory) { Restore-Shims -Prefix $prefix -Directory $shimBackupDirectory -OriginallyPresent $shimPresent }
        }
        Restore-RuntimeTaskActions -TaskSnapshot $taskSnapshot
        Restart-PreviousRuntime -TaskSnapshot $taskSnapshot
    }
    catch {}
    Write-UpdateStatus -State "rolled-back" -Extra (@{} + $checkPayload + @{ error = $failure.Exception.Message }) | Out-Null
    throw "DevSpace Ultra update failed and rollback was attempted: $($failure.Exception.Message)"
}
finally {
    if ($downloadedArchive -and $archivePath) { Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue }
    if ($staged -and (Test-Path -LiteralPath $staged.Prefix)) { Remove-Item -LiteralPath $staged.Prefix -Recurse -Force -ErrorAction SilentlyContinue }
}
