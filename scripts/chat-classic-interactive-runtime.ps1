[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet("status", "setup", "start", "stop", "live-gate")]
    [string]$Action,

    [ValidateRange(2, 32)]
    [int]$MainNumber = 2,

    [switch]$ForceRefresh,

    [switch]$ReseedSession,

    [switch]$NoPrimaryFallback,

    [ValidateRange(5, 60)]
    [int]$VerifyTimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
$provisioner = Join-Path $PSScriptRoot "chat-classic-runtime-provision.ps1"
$authSeedScript = Join-Path $PSScriptRoot "chat-swarm-classic-auth-seed.mjs"
$cdpSessionSeedScript = Join-Path $PSScriptRoot "chat-swarm-classic-session-seed.mjs"
$sessionSourceScript = Join-Path $PSScriptRoot "chat-classic-session-source.ps1"
$primarySnapshotScript = Join-Path $PSScriptRoot "chat-classic-primary-snapshot.ps1"
$bootstrapScript = Join-Path $PSScriptRoot "chat-swarm-classic-cdp-bootstrap.mjs"
$interactiveStateRoot = Join-Path $env:LOCALAPPDATA "DevSpace\ChatGPTInteractive"
$workerControllerStatePath = Join-Path $env:LOCALAPPDATA "DevSpace\ChatSwarmClassic\controller-state.json"
$debugBasePort = 9730

function Get-RootProcessForExecutable {
    param([string]$ExecutablePath)
    if ([string]::IsNullOrWhiteSpace($ExecutablePath)) { return $null }
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -eq "ChatGPT Classic.exe" -and
            $_.ExecutablePath -eq $ExecutablePath -and
            $_.CommandLine -notlike "*--type=*"
        } |
        Sort-Object CreationDate |
        Select-Object -First 1
}

function Get-PrimarySnapshot {
    $package = Get-AppxPackage -Name "OpenAI.ChatGPT-Desktop" -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if (-not $package) { throw "Canonical Main-01 package OpenAI.ChatGPT-Desktop is not installed." }
    $exe = Join-Path $package.InstallLocation "app\ChatGPT Classic.exe"
    $root = Get-RootProcessForExecutable -ExecutablePath $exe
    $process = if ($root) { Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue } else { $null }
    [pscustomobject]@{
        PackageName = $package.Name
        PackageFamilyName = $package.PackageFamilyName
        PackageFullName = $package.PackageFullName
        Version = [string]$package.Version
        ApplicationId = "ChatGPT"
        AppUserModelId = "$($package.PackageFamilyName)!ChatGPT"
        ExecutablePath = $exe
        ProfilePath = Join-Path $env:LOCALAPPDATA ("Packages\{0}\LocalCache\Roaming\ChatGPT" -f $package.PackageFamilyName)
        Running = [bool]$root
        Pid = if ($root) { [int]$root.ProcessId } else { $null }
        Visible = [bool]($process -and $process.MainWindowHandle -ne 0)
        WindowHandle = if ($process) { [long]$process.MainWindowHandle } else { 0 }
        WindowTitle = if ($process) { [string]$process.MainWindowTitle } else { "" }
    }
}

function Get-InteractiveRuntime {
    param([Parameter(Mandatory)][int]$Number)
    $padded = "{0:D2}" -f $Number
    $packageName = "OpenAI.ChatGPT-Desktop.Interactive$padded"
    $package = Get-AppxPackage -Name $packageName -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1
    $aliasName = "chatgpt-classic-main$padded.exe"
    $aliasPath = Join-Path $env:LOCALAPPDATA ("Microsoft\WindowsApps\" + $aliasName)
    $exe = if ($package) { Join-Path $package.InstallLocation "app\ChatGPT Classic.exe" } else { $null }
    $root = if ($exe) { Get-RootProcessForExecutable -ExecutablePath $exe } else { $null }
    $process = if ($root) { Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue } else { $null }
    [pscustomobject]@{
        Number = $Number
        RuntimeId = "interactive-$padded"
        Label = "Main-$padded"
        PackageName = $packageName
        PackageFamilyName = if ($package) { $package.PackageFamilyName } else { $null }
        PackageFullName = if ($package) { $package.PackageFullName } else { $null }
        ApplicationId = "DevSpaceInteractive"
        AppUserModelId = if ($package) { "$($package.PackageFamilyName)!DevSpaceInteractive" } else { $null }
        InstallLocation = if ($package) { $package.InstallLocation } else { $null }
        ExecutablePath = $exe
        Alias = $aliasName
        AliasPath = $aliasPath
        ProfilePath = if ($package) { Join-Path $env:LOCALAPPDATA ("Packages\{0}\LocalCache\Roaming\ChatGPT" -f $package.PackageFamilyName) } else { $null }
        DebugPort = $debugBasePort + $Number
        Registered = [bool]$package
        Running = [bool]$root
        Pid = if ($root) { [int]$root.ProcessId } else { $null }
        Visible = [bool]($process -and $process.MainWindowHandle -ne 0)
        WindowHandle = if ($process) { [long]$process.MainWindowHandle } else { 0 }
        WindowTitle = if ($process) { [string]$process.MainWindowTitle } else { "" }
    }
}

function Test-TcpPort {
    param([Parameter(Mandatory)][int]$Port)
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $task = $client.ConnectAsync("127.0.0.1", $Port)
        if (-not $task.Wait(250)) { $client.Dispose(); return $false }
        $ok = $client.Connected
        $client.Dispose()
        return $ok
    }
    catch { return $false }
}

function Get-SeedMarkerPath {
    param([Parameter(Mandatory)]$Runtime)
    Join-Path $interactiveStateRoot ($Runtime.RuntimeId + ".json")
}

function Read-SeedMarker {
    param([Parameter(Mandatory)]$Runtime)
    $path = Get-SeedMarkerPath -Runtime $Runtime
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try { Get-Content -LiteralPath $path -Raw | ConvertFrom-Json }
    catch { return $null }
}

function Write-SeedMarker {
    param(
        [Parameter(Mandatory)]$Runtime,
        [Parameter(Mandatory)]$Primary,
        [string]$ProvisioningMode = "session-seed",
        [string]$SourceRole = "primary",
        [string]$SourceLabel = "Main-01",
        [bool]$PrimaryRestarted = $false,
        [bool]$PrimaryRestored = $false
    )
    New-Item -ItemType Directory -Path $interactiveStateRoot -Force | Out-Null
    [ordered]@{
        version = 3
        runtimeId = $Runtime.RuntimeId
        label = $Runtime.Label
        packageName = $Runtime.PackageName
        packageFamilyName = $Runtime.PackageFamilyName
        sourcePrimaryPackage = $Primary.PackageName
        sourcePrimaryVersion = $Primary.Version
        provisioningMode = $ProvisioningMode
        sourceRole = $SourceRole
        sourceLabel = $SourceLabel
        primaryRestarted = $PrimaryRestarted
        primaryRestored = $PrimaryRestored
        provisionedAt = (Get-Date).ToString("o")
        authValuesPersistedByDevSpace = $false
        independentProfile = $true
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Get-SeedMarkerPath -Runtime $Runtime) -Encoding UTF8
}

function Assert-PrimaryReady {
    param([Parameter(Mandatory)]$Primary)
    if (-not $Primary.Running -or -not $Primary.Visible) {
        throw "Main-01 must already be running and visible before secondary Main management begins."
    }
}

function Assert-PrimaryUnchanged {
    param([Parameter(Mandatory)]$Before)
    $after = Get-PrimarySnapshot
    $same = [bool]($Before.Running -and $after.Running -and $Before.Pid -eq $after.Pid -and $after.Visible)
    if (-not $same) {
        throw "Main-01 changed during secondary Main management. PrimaryPidBefore=$($Before.Pid); PrimaryPidAfter=$($after.Pid)."
    }
    $after
}

function Start-InteractiveRuntime {
    param([Parameter(Mandatory)]$Runtime)
    if (-not $Runtime.Registered) { throw "$($Runtime.Label) is not registered. Run setup first." }
    if (-not (Test-Path -LiteralPath $Runtime.AliasPath)) { throw "$($Runtime.Label) execution alias is missing: $($Runtime.AliasPath)" }
    if ($Runtime.Running) { return $Runtime }

    $args = @(
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=$($Runtime.DebugPort)"
    )
    Start-Process -FilePath $Runtime.AliasPath -ArgumentList $args | Out-Null
    $deadline = (Get-Date).AddSeconds($VerifyTimeoutSeconds)
    $current = Get-InteractiveRuntime -Number $Runtime.Number
    do {
        if ($current.Running -and $current.Visible -and (Test-TcpPort -Port $current.DebugPort)) { break }
        Start-Sleep -Milliseconds 350
        $current = Get-InteractiveRuntime -Number $Runtime.Number
    } while ((Get-Date) -lt $deadline)

    if (-not $current.Running) { throw "$($Runtime.Label) did not produce an independent root process before timeout." }
    if (-not $current.Visible) { throw "$($Runtime.Label) process started but no user-facing window became visible before timeout." }
    if (-not (Test-TcpPort -Port $current.DebugPort)) { throw "$($Runtime.Label) started but its local verification port did not become ready." }
    $current
}

function Stop-InteractiveRuntime {
    param([Parameter(Mandatory)]$Runtime)
    if (-not $Runtime.Registered -or -not $Runtime.ExecutablePath) { return }
    $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -eq "ChatGPT Classic.exe" -and $_.ExecutablePath -eq $Runtime.ExecutablePath
    })
    foreach ($process in $processes) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-InteractiveProbe {
    param([Parameter(Mandatory)]$Runtime)
    if (-not (Test-TcpPort -Port $Runtime.DebugPort)) { return $null }
    if (-not (Test-Path -LiteralPath $bootstrapScript)) { throw "CDP bootstrap helper is missing: $bootstrapScript" }
    $node = (Get-Command node -ErrorAction Stop).Source
    $output = @(& $node $bootstrapScript --port $Runtime.DebugPort --probe --compact)
    if ($LASTEXITCODE -ne 0) { throw "CDP probe failed for $($Runtime.Label)." }
    $text = ($output -join "`n").Trim()
    try { ($text | ConvertFrom-Json).probe }
    catch { throw "CDP probe returned invalid JSON for $($Runtime.Label)." }
}

function Test-InteractiveSignedIn {
    param([Parameter(Mandatory)]$Runtime)
    $probe = Invoke-InteractiveProbe -Runtime $Runtime
    [pscustomobject]@{
        SignedIn = [bool]($probe -and $probe.composer -and -not $probe.composerDisabled -and -not $probe.loginVisible)
        Probe = $probe
    }
}

function Seed-InteractiveSession {
    param(
        [Parameter(Mandatory)]$Primary,
        [Parameter(Mandatory)]$Runtime
    )
    if (-not (Test-Path -LiteralPath $authSeedScript)) { throw "Secure Session Seed helper is missing: $authSeedScript" }
    if ($Runtime.Running) { throw "Session Seed requires $($Runtime.Label) to be stopped so its independent profile is not modified while in use." }
    if (-not (Test-Path -LiteralPath $Primary.ProfilePath)) { throw "Main-01 profile is unavailable for read-only Session Seed." }
    $node = (Get-Command node -ErrorAction Stop).Source
    $output = @(& $node $authSeedScript --source-profile $Primary.ProfilePath --target-profile $Runtime.ProfilePath)
    $exitCode = if ($null -eq $LASTEXITCODE) { 1 } else { [int]$LASTEXITCODE }
    $text = ($output -join "`n").Trim()
    try { $result = $text | ConvertFrom-Json }
    catch { throw "Secure Session Seed returned invalid JSON for $($Runtime.Label)." }
    if ($result.secretValuesLogged) { throw "Secure Session Seed violated the no-secret-output gate." }
    if ($exitCode -ne 0 -or -not $result.ok) {
        if ([string]$result.reason -eq "source-locked") { return $result }
        throw "Secure Session Seed failed for $($Runtime.Label) at $([string]$result.stage)/$([string]$result.reason)."
    }
    $result
}

function Get-SessionSourceCandidates {
    param([Parameter(Mandatory)][int]$TargetNumber)
    if (-not (Test-Path -LiteralPath $sessionSourceScript)) { throw "Interactive session source helper is missing: $sessionSourceScript" }
    $output = @(& $sessionSourceScript -TargetMainNumber $TargetNumber)
    if ($LASTEXITCODE -ne 0) { throw "Interactive session source discovery failed for Main-$('{0:D2}' -f $TargetNumber)." }
    $text = ($output -join "`n").Trim()
    try { $result = $text | ConvertFrom-Json }
    catch { throw "Interactive session source discovery returned invalid JSON." }
    if ($result.SecretValuesLogged) { throw "Interactive session source discovery violated the no-secret-output gate." }
    return @($result.Candidates)
}

function Seed-InteractiveFromCdpSource {
    param(
        [Parameter(Mandatory)]$Source,
        [Parameter(Mandatory)]$Runtime
    )
    if (-not (Test-Path -LiteralPath $cdpSessionSeedScript)) { throw "CDP Session Seed helper is missing: $cdpSessionSeedScript" }
    if (-not $Runtime.Running -or -not (Test-TcpPort -Port $Runtime.DebugPort)) { throw "$($Runtime.Label) must be running with CDP before in-memory Session Seed." }
    if (-not $Source.DebugPort -or -not (Test-TcpPort -Port ([int]$Source.DebugPort))) { throw "$([string]$Source.Label) seed source CDP is offline." }
    $node = (Get-Command node -ErrorAction Stop).Source
    $output = @(& $node $cdpSessionSeedScript --source-port ([string]$Source.DebugPort) --target-port ([string]$Runtime.DebugPort) --verify-seconds 15)
    if ($LASTEXITCODE -ne 0) { throw "CDP Session Seed failed for $($Runtime.Label)." }
    $text = ($output -join "`n").Trim()
    try { $result = $text | ConvertFrom-Json }
    catch { throw "CDP Session Seed returned invalid JSON for $($Runtime.Label)." }
    if ($result.secretValuesLogged -or -not $result.allowlistedDomainsOnly) { throw "CDP Session Seed violated the no-secret/allowlist gate." }
    if (-not $result.ok -or -not $result.targetVerified) { throw "CDP Session Seed did not verify $($Runtime.Label) as signed in." }
    $result
}

function Invoke-ControlledPrimarySnapshot {
    param(
        [Parameter(Mandatory)]$Runtime,
        [Parameter(Mandatory)][int]$TimeoutSeconds
    )
    if ($Runtime.Running) { throw "Controlled Primary snapshot requires $($Runtime.Label) to be stopped before profile mutation." }
    if (-not (Test-Path -LiteralPath $primarySnapshotScript)) { throw "Controlled Primary snapshot helper is missing: $primarySnapshotScript" }
    $output = @(& $primarySnapshotScript -TargetProfile $Runtime.ProfilePath -VerifyTimeoutSeconds ([Math]::Max(10, $TimeoutSeconds)))
    $exitCode = if ($null -eq $LASTEXITCODE) { 1 } else { [int]$LASTEXITCODE }
    $text = ($output -join "`n").Trim()
    try { $result = $text | ConvertFrom-Json }
    catch { throw "Controlled Primary snapshot returned invalid JSON." }
    if ($result.SecretValuesLogged -or $result.AuthValuesPersistedByDevSpace) { throw "Controlled Primary snapshot violated the no-secret-persistence gate." }
    if ($exitCode -ne 0 -or -not $result.Ok -or -not $result.PrimaryRestored) {
        throw "Controlled Primary snapshot failed closed at $([string]$result.Stage)/$([string]$result.Reason)."
    }
    $result
}

function Resolve-PrimaryAfterOperation {
    param(
        [Parameter(Mandatory)]$Before,
        [bool]$PrimaryRestarted = $false,
        [bool]$PrimaryRestored = $false
    )
    if (-not $PrimaryRestarted) { return Assert-PrimaryUnchanged -Before $Before }
    $after = Get-PrimarySnapshot
    if (-not $PrimaryRestored -or -not $after.Running -or -not $after.Visible) {
        throw "Main-01 did not pass the controlled restore gate."
    }
    return $after
}

function Get-ManifestIsolation {
    param([Parameter(Mandatory)]$Runtime)
    if (-not $Runtime.Registered) {
        return [pscustomobject]@{ Clean = $false; ApplicationId = $null; ExtensionCategories = @(); AppListEntry = $null }
    }
    $manifestPath = Join-Path $Runtime.InstallLocation "AppxManifest.xml"
    [xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
    $ns = [System.Xml.XmlNamespaceManager]::new($manifest.NameTable)
    $ns.AddNamespace("f", "http://schemas.microsoft.com/appx/manifest/foundation/windows10")
    $ns.AddNamespace("uap", "http://schemas.microsoft.com/appx/manifest/uap/windows10")
    $application = $manifest.SelectSingleNode("/f:Package/f:Applications/f:Application", $ns)
    $visual = $manifest.SelectSingleNode("/f:Package/f:Applications/f:Application/uap:VisualElements", $ns)
    $categories = @($application.Extensions.Extension | ForEach-Object { [string]$_.Category } | Where-Object { $_ })
    $forbidden = @("windows.protocol", "windows.startupTask", "windows.appExtension")
    $clean = [bool]([string]$application.Id -eq "DevSpaceInteractive" -and [string]$visual.AppListEntry -ne "none" -and @($categories | Where-Object { $forbidden -contains $_ }).Count -eq 0)
    [pscustomobject]@{
        Clean = $clean
        ApplicationId = [string]$application.Id
        ExtensionCategories = $categories
        AppListEntry = [string]$visual.AppListEntry
    }
}

function Test-WorkerControllerListing {
    param([Parameter(Mandatory)]$Runtime)
    if (-not (Test-Path -LiteralPath $workerControllerStatePath)) { return $false }
    try {
        $state = Get-Content -LiteralPath $workerControllerStatePath -Raw | ConvertFrom-Json
        [bool](@($state.workers | Where-Object { [string]$_.packageName -eq $Runtime.PackageName }).Count -gt 0)
    }
    catch { return $false }
}

function Get-StatusPayload {
    param(
        [Parameter(Mandatory)]$PrimaryBefore,
        [Parameter(Mandatory)]$PrimaryAfter,
        [Parameter(Mandatory)]$Runtime,
        [string]$State = "status",
        [bool]$SeededThisRun = $false,
        [Nullable[bool]]$SessionVerified = $null,
        [bool]$AuthRequired = $false,
        [Nullable[int]]$PreviousInteractivePid = $null,
        [bool]$PrimaryRestarted = $false,
        [bool]$PrimaryRestored = $false,
        [string]$SessionSourceRole = $null,
        [string]$SessionSourceLabel = $null
    )
    $isolation = Get-ManifestIsolation -Runtime $Runtime
    $marker = Read-SeedMarker -Runtime $Runtime
    [ordered]@{
        Ok = $true
        Action = $Action
        State = $State
        Label = $Runtime.Label
        Number = $Runtime.Number
        PackageName = $Runtime.PackageName
        PackageFamilyName = $Runtime.PackageFamilyName
        ApplicationId = $Runtime.ApplicationId
        AppUserModelId = $Runtime.AppUserModelId
        Registered = $Runtime.Registered
        Running = $Runtime.Running
        Visible = $Runtime.Visible
        Pid = $Runtime.Pid
        PreviousInteractivePid = $PreviousInteractivePid
        Alias = $Runtime.Alias
        ProfilePath = $Runtime.ProfilePath
        DebugPort = $Runtime.DebugPort
        SeedMarkerPresent = [bool]$marker
        SeededThisRun = $SeededThisRun
        SessionVerified = $SessionVerified
        AuthRequired = $AuthRequired
        ProvisioningMode = if ($marker -and $marker.PSObject.Properties.Name -contains "provisioningMode") { [string]$marker.provisioningMode } else { $null }
        SessionSourceRole = if ($SessionSourceRole) { $SessionSourceRole } elseif ($marker -and $marker.PSObject.Properties.Name -contains "sourceRole") { [string]$marker.sourceRole } else { $null }
        SessionSourceLabel = if ($SessionSourceLabel) { $SessionSourceLabel } elseif ($marker -and $marker.PSObject.Properties.Name -contains "sourceLabel") { [string]$marker.sourceLabel } else { $null }
        IndependentProfile = [bool]($Runtime.ProfilePath -and $Runtime.ProfilePath -ne $PrimaryAfter.ProfilePath)
        ManifestIsolationSafe = [bool]$isolation.Clean
        ManifestApplicationId = $isolation.ApplicationId
        ManifestExtensionCategories = @($isolation.ExtensionCategories)
        AppListEntry = $isolation.AppListEntry
        WorkerControllerListed = Test-WorkerControllerListing -Runtime $Runtime
        WorkerManaged = $false
        AutoCompactManaged = $false
        ChatSwarmAutojoin = $false
        GlobalProtocolOwner = $false
        Main01Unchanged = [bool](-not $PrimaryRestarted -and $PrimaryBefore.Pid -eq $PrimaryAfter.Pid -and $PrimaryAfter.Running -and $PrimaryAfter.Visible)
        PrimaryRestarted = $PrimaryRestarted
        PrimaryRestored = if ($PrimaryRestarted) { $PrimaryRestored } else { [bool]$PrimaryAfter.Running }
        PrimaryPidBefore = $PrimaryBefore.Pid
        PrimaryPidAfter = $PrimaryAfter.Pid
        PrimaryWindowBefore = $PrimaryBefore.WindowHandle
        PrimaryWindowAfter = $PrimaryAfter.WindowHandle
        PrimaryAppUserModelId = $PrimaryAfter.AppUserModelId
    }
}

$primaryBefore = Get-PrimarySnapshot
$runtime = Get-InteractiveRuntime -Number $MainNumber

if ($Action -ne "status") { Assert-PrimaryReady -Primary $primaryBefore }

switch ($Action) {
    "status" {
        $primaryAfter = Get-PrimarySnapshot
        Get-StatusPayload -PrimaryBefore $primaryBefore -PrimaryAfter $primaryAfter -Runtime $runtime | ConvertTo-Json -Depth 8 -Compress
    }

    "setup" {
        if (-not (Test-Path -LiteralPath $provisioner)) { throw "Role-aware runtime provisioner is missing: $provisioner" }
        if ($runtime.Running -and ($ForceRefresh -or $ReseedSession)) {
            throw "$($runtime.Label) is running; refusing package refresh/reseed while its user-facing profile is active."
        }

        $null = @(& $provisioner -Role interactive -Count 1 -FirstNumber $MainNumber -ForceRefresh:$ForceRefresh)
        $runtime = Get-InteractiveRuntime -Number $MainNumber
        if (-not $runtime.Registered) { throw "$($runtime.Label) provisioning did not register an independent package." }

        $marker = Read-SeedMarker -Runtime $runtime
        $seededThisRun = $false
        $authRequired = $false
        $primaryRestarted = $false
        $primaryRestored = $false
        $provisioningMode = $null
        $sessionSourceRole = $null
        $sessionSourceLabel = $null

        # Always verify the target's real UI first. A marker is provenance, not proof
        # that a months-old ChatGPT session is still valid.
        $runtime = Start-InteractiveRuntime -Runtime $runtime
        $session = Test-InteractiveSignedIn -Runtime $runtime
        if ($session.SignedIn -and -not $ReseedSession) {
            $provisioningMode = if ($marker -and $marker.PSObject.Properties.Name -contains "provisioningMode") { [string]$marker.provisioningMode } else { "verified-existing-session" }
            $sessionSourceRole = if ($marker -and $marker.PSObject.Properties.Name -contains "sourceRole") { [string]$marker.sourceRole } else { "interactive" }
            $sessionSourceLabel = if ($marker -and $marker.PSObject.Properties.Name -contains "sourceLabel") { [string]$marker.sourceLabel } else { $runtime.Label }
        }
        else {
            $sources = @(Get-SessionSourceCandidates -TargetNumber $MainNumber)
            $cdpSource = @($sources | Where-Object { $_.Role -eq "interactive" -or $_.Role -eq "worker" } | Select-Object -First 1)
            if ($cdpSource.Count -gt 0) {
                $source = $cdpSource[0]
                $null = Seed-InteractiveFromCdpSource -Source $source -Runtime $runtime
                $seededThisRun = $true
                $provisioningMode = "cdp-session-seed"
                $sessionSourceRole = [string]$source.Role
                $sessionSourceLabel = [string]$source.Label
                $session = Test-InteractiveSignedIn -Runtime $runtime
            }
            else {
                $primarySource = @($sources | Where-Object { $_.Role -eq "primary" } | Select-Object -First 1)
                if ($NoPrimaryFallback -or $primarySource.Count -eq 0) {
                    $authRequired = $true
                }
                else {
                    # The canonical profile is tried read-only while Main-01 is still
                    # running. If Windows holds the Cookies DB with 0x80070020, the
                    # approved zero-login fallback performs one controlled Primary
                    # close -> encrypted snapshot -> relaunch -> signed-in verify.
                    Stop-InteractiveRuntime -Runtime $runtime
                    Start-Sleep -Milliseconds 350
                    $runtime = Get-InteractiveRuntime -Number $MainNumber
                    $seed = Seed-InteractiveSession -Primary $primaryBefore -Runtime $runtime
                    if ($seed.ok) {
                        $seededThisRun = $true
                        $provisioningMode = "primary-online-snapshot"
                        $sessionSourceRole = "primary"
                        $sessionSourceLabel = "Main-01"
                    }
                    elseif ([string]$seed.reason -eq "source-locked") {
                        $controlled = Invoke-ControlledPrimarySnapshot -Runtime $runtime -TimeoutSeconds $VerifyTimeoutSeconds
                        $primaryRestarted = [bool]$controlled.PrimaryRestarted
                        $primaryRestored = [bool]$controlled.PrimaryRestored
                        $seededThisRun = [bool]$controlled.SessionSeeded
                        $provisioningMode = "primary-controlled-snapshot"
                        $sessionSourceRole = "primary"
                        $sessionSourceLabel = "Main-01"
                    }
                    $runtime = Start-InteractiveRuntime -Runtime (Get-InteractiveRuntime -Number $MainNumber)
                    $session = Test-InteractiveSignedIn -Runtime $runtime
                    if (-not $session.SignedIn) { $authRequired = $true }
                }
            }
        }

        if ($authRequired -and -not $session.SignedIn) {
            $primaryAfter = Resolve-PrimaryAfterOperation -Before $primaryBefore -PrimaryRestarted $primaryRestarted -PrimaryRestored $primaryRestored
            $payload = Get-StatusPayload -PrimaryBefore $primaryBefore -PrimaryAfter $primaryAfter -Runtime $runtime -State "interactive-auth-required" -SessionVerified $false -AuthRequired $true -PrimaryRestarted $primaryRestarted -PrimaryRestored $primaryRestored -SessionSourceRole $sessionSourceRole -SessionSourceLabel $sessionSourceLabel
            if (-not $payload.ManifestIsolationSafe -or $payload.WorkerControllerListed -or -not $payload.IndependentProfile) {
                throw "$($runtime.Label) failed an isolation gate while waiting for cold-start Interactive authentication."
            }
            $payload | ConvertTo-Json -Depth 8 -Compress
            break
        }

        if (-not $session.SignedIn) {
            throw "$($runtime.Label) opened but its ChatGPT session did not verify as signed in."
        }
        if (-not $provisioningMode) { $provisioningMode = "verified-existing-session" }
        if (-not $sessionSourceRole) { $sessionSourceRole = "interactive" }
        if (-not $sessionSourceLabel) { $sessionSourceLabel = $runtime.Label }
        Write-SeedMarker -Runtime $runtime -Primary $primaryBefore -ProvisioningMode $provisioningMode -SourceRole $sessionSourceRole -SourceLabel $sessionSourceLabel -PrimaryRestarted $primaryRestarted -PrimaryRestored $primaryRestored

        $primaryAfter = Resolve-PrimaryAfterOperation -Before $primaryBefore -PrimaryRestarted $primaryRestarted -PrimaryRestored $primaryRestored
        $payload = Get-StatusPayload -PrimaryBefore $primaryBefore -PrimaryAfter $primaryAfter -Runtime (Get-InteractiveRuntime -Number $MainNumber) -State "ready" -SeededThisRun $seededThisRun -SessionVerified $true -PrimaryRestarted $primaryRestarted -PrimaryRestored $primaryRestored -SessionSourceRole $sessionSourceRole -SessionSourceLabel $sessionSourceLabel
        if (-not $payload.ManifestIsolationSafe -or $payload.WorkerControllerListed -or -not $payload.IndependentProfile) {
            throw "$($runtime.Label) failed an isolation gate after provisioning."
        }
        $payload | ConvertTo-Json -Depth 8 -Compress
    }

    "start" {
        if (-not $runtime.Registered) { throw "$($runtime.Label) is not registered. Run setup first." }
        $runtime = Start-InteractiveRuntime -Runtime $runtime
        $session = Test-InteractiveSignedIn -Runtime $runtime
        $primaryAfter = Assert-PrimaryUnchanged -Before $primaryBefore
        Get-StatusPayload -PrimaryBefore $primaryBefore -PrimaryAfter $primaryAfter -Runtime $runtime -State "started" -SessionVerified $session.SignedIn | ConvertTo-Json -Depth 8 -Compress
    }

    "stop" {
        Stop-InteractiveRuntime -Runtime $runtime
        Start-Sleep -Milliseconds 500
        $primaryAfter = Assert-PrimaryUnchanged -Before $primaryBefore
        Get-StatusPayload -PrimaryBefore $primaryBefore -PrimaryAfter $primaryAfter -Runtime (Get-InteractiveRuntime -Number $MainNumber) -State "stopped" | ConvertTo-Json -Depth 8 -Compress
    }

    "live-gate" {
        if (-not $runtime.Registered) {
            throw "$($runtime.Label) must be provisioned before the live restart gate."
        }
        $runtime = Start-InteractiveRuntime -Runtime $runtime
        $beforeSession = Test-InteractiveSignedIn -Runtime $runtime
        if (-not $beforeSession.SignedIn) { throw "$($runtime.Label) is not signed in before the restart gate." }
        if (-not (Read-SeedMarker -Runtime $runtime)) {
            # A secondary Main may have been authenticated through the bounded
            # OAuth relay fallback when canonical Main-01 keeps its Chromium
            # cookie database exclusively locked. UI verification is authoritative;
            # persist only a non-secret marker so later setup/live gates do not
            # attempt to overwrite this independently authenticated profile.
            Write-SeedMarker -Runtime $runtime -Primary $primaryBefore -ProvisioningMode "verified-existing-session"
        }
        $previousPid = [int]$runtime.Pid
        Stop-InteractiveRuntime -Runtime $runtime
        Start-Sleep -Milliseconds 700
        $runtime = Start-InteractiveRuntime -Runtime (Get-InteractiveRuntime -Number $MainNumber)
        $afterSession = Test-InteractiveSignedIn -Runtime $runtime
        if (-not $afterSession.SignedIn) { throw "$($runtime.Label) lost its independent signed-in session after restart." }
        if ([int]$runtime.Pid -eq $previousPid) { throw "$($runtime.Label) restart gate did not produce a new root PID." }
        $primaryAfter = Assert-PrimaryUnchanged -Before $primaryBefore
        $payload = Get-StatusPayload -PrimaryBefore $primaryBefore -PrimaryAfter $primaryAfter -Runtime $runtime -State "restart-persistence-pass" -SessionVerified $true -PreviousInteractivePid $previousPid
        if (-not $payload.ManifestIsolationSafe -or $payload.WorkerControllerListed) { throw "$($runtime.Label) failed isolation after restart." }
        $payload | ConvertTo-Json -Depth 8 -Compress
    }
}
