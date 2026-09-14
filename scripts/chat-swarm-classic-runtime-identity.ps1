[CmdletBinding()]
param(
    [ValidateSet("audit", "repair", "repair-protocol", "guard", "install-guard", "remove-guard")]
    [string]$Action = "audit",

    [ValidateRange(0, 120)]
    [int]$PrimaryLaunchWaitSeconds = 12,

    [switch]$NoWindowActivation
)

$ErrorActionPreference = "Stop"
$cloneScript = Join-Path $PSScriptRoot "chat-swarm-classic-runtime-clone.ps1"
$controllerScript = Join-Path $PSScriptRoot "chat-swarm-classic-controller.ps1"
$taskName = "DevSpace-ChatGPT-Primary-Identity-Guard"
$healTaskName = "DevSpace-ChatGPT-Worker-Identity-Heal"
$scriptSelf = $PSCommandPath

function Get-PrimaryPackage {
    Get-AppxPackage -Name "OpenAI.ChatGPT-Desktop" |
        Sort-Object Version -Descending |
        Select-Object -First 1
}

function Get-WorkerPackages {
    @(Get-AppxPackage |
        Where-Object { $_.Name -match '^OpenAI\.ChatGPT-Desktop\.Worker\d{2}$' } |
        Sort-Object Name)
}

function Get-InteractivePackages {
    @(Get-AppxPackage |
        Where-Object { $_.Name -match '^OpenAI\.ChatGPT-Desktop\.Interactive\d{2}$' } |
        Sort-Object Name)
}

function Get-RootProcessForPackage {
    param([Parameter(Mandatory)]$Package)
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -eq "ChatGPT Classic.exe" -and
            $_.ExecutablePath -and
            $_.ExecutablePath.StartsWith($Package.InstallLocation, [System.StringComparison]::OrdinalIgnoreCase) -and
            $_.CommandLine -notlike "*--type=*"
        } |
        Select-Object -First 1
}

function Get-PackageProtocolProgId {
    param(
        [Parameter(Mandatory)]$Package,
        [Parameter(Mandatory)][string]$ApplicationId
    )
    $path = "HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages\$($Package.PackageFullName)\$ApplicationId\Capabilities\URLAssociations"
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $value = [string](Get-ItemProperty -LiteralPath $path -Name chatgpt -ErrorAction SilentlyContinue).chatgpt
    if ([string]::IsNullOrWhiteSpace($value)) { return $null }
    return $value
}

function Get-CurrentProtocolClaims {
    $claims = @()
    $primary = Get-PrimaryPackage
    if ($primary) {
        $progId = Get-PackageProtocolProgId -Package $primary -ApplicationId "ChatGPT"
        if ($progId) {
            $claims += [pscustomobject]@{
                Role = "primary"
                Worker = $null
                Interactive = $null
                ProgId = $progId
                AppUserModelID = "$($primary.PackageFamilyName)!ChatGPT"
                PackageName = $primary.Name
                ApplicationId = "ChatGPT"
            }
        }
    }
    foreach ($package in Get-WorkerPackages) {
        $numberMatch = [regex]::Match($package.Name, 'Worker(\d{2})$')
        $number = if ($numberMatch.Success) { [int]$numberMatch.Groups[1].Value } else { 0 }
        # Check both identities during migration. New workers use DevSpaceWorker;
        # legacy packages may still be registered under !ChatGPT until re-register.
        foreach ($applicationId in @("DevSpaceWorker", "ChatGPT")) {
            $progId = Get-PackageProtocolProgId -Package $package -ApplicationId $applicationId
            if (-not $progId) { continue }
            $claims += [pscustomobject]@{
                Role = "worker"
                Worker = $number
                Interactive = $null
                ProgId = $progId
                AppUserModelID = "$($package.PackageFamilyName)!$applicationId"
                PackageName = $package.Name
                ApplicationId = $applicationId
            }
        }
    }
    foreach ($package in Get-InteractivePackages) {
        $numberMatch = [regex]::Match($package.Name, 'Interactive(\d{2})$')
        $number = if ($numberMatch.Success) { [int]$numberMatch.Groups[1].Value } else { 0 }
        foreach ($applicationId in @("DevSpaceInteractive", "ChatGPT")) {
            $progId = Get-PackageProtocolProgId -Package $package -ApplicationId $applicationId
            if (-not $progId) { continue }
            $claims += [pscustomobject]@{
                Role = "interactive"
                Worker = $null
                Interactive = $number
                ProgId = $progId
                AppUserModelID = "$($package.PackageFamilyName)!$applicationId"
                PackageName = $package.Name
                ApplicationId = $applicationId
            }
        }
    }
    @($claims)
}

function Get-ProgIdApplicationMetadata {
    param([string]$ProgId)
    if ([string]::IsNullOrWhiteSpace($ProgId)) { return $null }
    foreach ($path in @(
        "HKCU:\Software\Classes\$ProgId\Application",
        "Registry::HKEY_CLASSES_ROOT\$ProgId\Application"
    )) {
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $application = Get-ItemProperty -LiteralPath $path -ErrorAction SilentlyContinue
        if ($application) { return $application }
    }
    return $null
}

function Invoke-PowerShellChild {
    param(
        [Parameter(Mandatory)][string]$ScriptPath,
        [string[]]$Arguments = @()
    )
    # Windows PowerShell 5 surfaces redirected native stderr as ErrorRecord objects.
    # With this script's global ErrorActionPreference=Stop, one child stderr line can
    # otherwise abort the whole heal loop before we inspect the actual exit code.
    $previousPreference = $ErrorActionPreference
    $output = @()
    $exitCode = 1
    try {
        $ErrorActionPreference = "Continue"
        $output = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @Arguments 2>&1)
        $exitCode = if ($null -eq $LASTEXITCODE) { 1 } else { [int]$LASTEXITCODE }
    }
    catch {
        $output += $_
        $exitCode = if ($null -eq $LASTEXITCODE) { 1 } else { [int]$LASTEXITCODE }
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
    [pscustomobject]@{
        ExitCode = $exitCode
        Output = @($output | ForEach-Object { [string]$_ })
    }
}

function Get-ProtocolOwner {
    $choicePath = "HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\chatgpt\UserChoice"
    $primary = Get-PrimaryPackage
    $primaryAumid = if ($primary) { "$($primary.PackageFamilyName)!ChatGPT" } else { $null }
    $primaryProgId = if ($primary) { Get-PackageProtocolProgId -Package $primary -ApplicationId "ChatGPT" } else { $null }
    if (-not (Test-Path -LiteralPath $choicePath)) {
        return [pscustomobject]@{
            State = "unassigned"
            ProgId = $null
            PrimaryProgId = $primaryProgId
            ApplicationName = $null
            AppUserModelID = $null
            ActiveClaim = $false
            IsPrimary = $false
            IsWorker = $false
            Worker = $null
            IsInteractive = $false
            Interactive = $null
            IsStale = $false
            NeedsUserDefaultRepair = $true
        }
    }

    $progId = [string](Get-ItemProperty -LiteralPath $choicePath -ErrorAction SilentlyContinue).ProgId
    $claims = @(Get-CurrentProtocolClaims)
    $claim = @($claims | Where-Object { [string]::Equals([string]$_.ProgId, $progId, [System.StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1)
    if ($claim.Count -gt 0) {
        $current = $claim[0]
        $isPrimary = $current.Role -eq "primary"
        $isWorker = $current.Role -eq "worker"
        $isInteractive = $current.Role -eq "interactive"
        return [pscustomobject]@{
            State = if ($isPrimary) { "primary-current" } elseif ($isWorker) { "worker-current" } else { "interactive-current" }
            ProgId = $progId
            PrimaryProgId = $primaryProgId
            ApplicationName = if ($isPrimary) { "ChatGPT Classic" } elseif ($isWorker) { "ChatGPT Worker {0:D2}" -f [int]$current.Worker } else { "ChatGPT Main {0:D2}" -f [int]$current.Interactive }
            AppUserModelID = [string]$current.AppUserModelID
            ActiveClaim = $true
            IsPrimary = $isPrimary
            IsWorker = $isWorker
            Worker = if ($isWorker) { [int]$current.Worker } else { $null }
            IsInteractive = $isInteractive
            Interactive = if ($isInteractive) { [int]$current.Interactive } else { $null }
            IsStale = $false
            NeedsUserDefaultRepair = -not $isPrimary
        }
    }

    # UserChoice can outlive the AppX registration that created its ProgID. Resolve
    # metadata only as a legacy fallback; absence of a current package claim means
    # the choice is stale even if an old AUMID string is still discoverable.
    $application = Get-ProgIdApplicationMetadata -ProgId $progId
    $aumid = [string]$application.AppUserModelID
    $legacyWorker = [regex]::Match($aumid, '^OpenAI\.ChatGPT-Desktop\.Worker(\d{2})_2p2nqsd0c76g0!(?:ChatGPT|DevSpaceWorker)$')
    $legacyInteractive = [regex]::Match($aumid, '^OpenAI\.ChatGPT-Desktop\.Interactive(\d{2})_2p2nqsd0c76g0!(?:ChatGPT|DevSpaceInteractive)$')
    $isLegacyPrimary = -not [string]::IsNullOrWhiteSpace($primaryAumid) -and $aumid -eq $primaryAumid
    [pscustomobject]@{
        State = if ($legacyWorker.Success) { "worker-stale" } elseif ($legacyInteractive.Success) { "interactive-stale" } elseif ($isLegacyPrimary) { "primary-stale" } else { "stale-unknown" }
        ProgId = $progId
        PrimaryProgId = $primaryProgId
        ApplicationName = [string]$application.ApplicationName
        AppUserModelID = $aumid
        ActiveClaim = $false
        IsPrimary = $false
        IsWorker = $legacyWorker.Success
        Worker = if ($legacyWorker.Success) { [int]$legacyWorker.Groups[1].Value } else { $null }
        IsInteractive = $legacyInteractive.Success
        Interactive = if ($legacyInteractive.Success) { [int]$legacyInteractive.Groups[1].Value } else { $null }
        IsStale = $true
        NeedsUserDefaultRepair = $true
    }
}

function Get-WorkerIdentityRow {
    param([Parameter(Mandatory)]$Package)
    $manifestPath = Join-Path $Package.InstallLocation "AppxManifest.xml"
    $text = if (Test-Path -LiteralPath $manifestPath) { Get-Content -LiteralPath $manifestPath -Raw } else { "" }
    $root = Get-RootProcessForPackage -Package $Package
    $numberMatch = [regex]::Match($Package.Name, 'Worker(\d{2})$')
    $number = if ($numberMatch.Success) { [int]$numberMatch.Groups[1].Value } else { 0 }

    # The loose package manifest can be staged clean while Windows still has the
    # previous registration active. Audit both the legacy !ChatGPT registration
    # and the canonical !DevSpaceWorker registration during migration.
    $applicationMatch = [regex]::Match($text, '<Application\b[^>]*\bId="([^"]+)"')
    $applicationId = if ($applicationMatch.Success) { $applicationMatch.Groups[1].Value } else { $null }
    $registeredProtocol = $false
    foreach ($candidateApplicationId in @("ChatGPT", "DevSpaceWorker")) {
        if (Get-PackageProtocolProgId -Package $Package -ApplicationId $candidateApplicationId) {
            $registeredProtocol = $true
            break
        }
    }
    $workerAumids = @(
        "$($Package.PackageFamilyName)!ChatGPT",
        "$($Package.PackageFamilyName)!DevSpaceWorker"
    )
    $registeredInAppList = [bool](Get-StartApps | Where-Object { $workerAumids -contains $_.AppID } | Select-Object -First 1)

    $manifestClean = ($applicationId -eq "DevSpaceWorker") -and (-not $text.Contains('windows.protocol')) -and (-not $text.Contains('windows.startupTask')) -and (-not $text.Contains('com.microsoft.windows.copilotkeyprovider')) -and ($text -match 'AppListEntry="none"')
    $registeredClean = (-not $registeredProtocol) -and (-not $registeredInAppList)
    [pscustomobject]@{
        Number = $number
        Name = $Package.Name
        ApplicationId = $applicationId
        AppUserModelID = "$($Package.PackageFamilyName)!$applicationId"
        Running = [bool]$root
        Pid = if ($root) { [int]$root.ProcessId } else { $null }
        HasProtocol = $text.Contains('windows.protocol')
        HasStartupTask = $text.Contains('windows.startupTask')
        HasCopilotExtension = $text.Contains('com.microsoft.windows.copilotkeyprovider')
        HiddenFromAppList = $text -match 'AppListEntry="none"'
        RegisteredProtocol = $registeredProtocol
        RegisteredInAppList = $registeredInAppList
        Alias = if ($text -match 'chatgpt-classic-worker\d+\.exe') { $Matches[0] } else { $null }
        ManifestPath = $manifestPath
        ManifestClean = $manifestClean
        RegisteredClean = $registeredClean
        Clean = $manifestClean -and $registeredClean
    }
}

function Get-InteractiveIdentityRow {
    param([Parameter(Mandatory)]$Package)
    $manifestPath = Join-Path $Package.InstallLocation "AppxManifest.xml"
    $text = if (Test-Path -LiteralPath $manifestPath) { Get-Content -LiteralPath $manifestPath -Raw } else { "" }
    $root = Get-RootProcessForPackage -Package $Package
    $numberMatch = [regex]::Match($Package.Name, 'Interactive(\d{2})$')
    $number = if ($numberMatch.Success) { [int]$numberMatch.Groups[1].Value } else { 0 }
    $applicationMatch = [regex]::Match($text, '<Application\b[^>]*\bId="([^"]+)"')
    $applicationId = if ($applicationMatch.Success) { $applicationMatch.Groups[1].Value } else { $null }

    $registeredProtocol = $false
    foreach ($candidateApplicationId in @("DevSpaceInteractive", "ChatGPT")) {
        if (Get-PackageProtocolProgId -Package $Package -ApplicationId $candidateApplicationId) {
            $registeredProtocol = $true
            break
        }
    }
    $interactiveAumids = @(
        "$($Package.PackageFamilyName)!DevSpaceInteractive",
        "$($Package.PackageFamilyName)!ChatGPT"
    )
    $registeredInAppList = [bool](Get-StartApps | Where-Object { $interactiveAumids -contains $_.AppID } | Select-Object -First 1)
    $hiddenFromAppList = [bool]($text -match 'AppListEntry="none"')
    $manifestClean = ($applicationId -eq "DevSpaceInteractive") -and (-not $text.Contains('windows.protocol')) -and (-not $text.Contains('windows.startupTask')) -and (-not $text.Contains('com.microsoft.windows.copilotkeyprovider')) -and (-not $hiddenFromAppList)
    $registeredClean = -not $registeredProtocol

    [pscustomobject]@{
        Number = $number
        Label = "Main-{0:D2}" -f $number
        Name = $Package.Name
        ApplicationId = $applicationId
        AppUserModelID = "$($Package.PackageFamilyName)!$applicationId"
        Running = [bool]$root
        Pid = if ($root) { [int]$root.ProcessId } else { $null }
        HasProtocol = $text.Contains('windows.protocol')
        HasStartupTask = $text.Contains('windows.startupTask')
        HasCopilotExtension = $text.Contains('com.microsoft.windows.copilotkeyprovider')
        HiddenFromAppList = $hiddenFromAppList
        RegisteredProtocol = $registeredProtocol
        RegisteredInAppList = $registeredInAppList
        Alias = if ($text -match 'chatgpt-classic-main\d+\.exe') { $Matches[0] } else { $null }
        ManifestPath = $manifestPath
        ManifestClean = $manifestClean
        RegisteredClean = $registeredClean
        Clean = $manifestClean -and $registeredClean
        WorkerManaged = $false
    }
}

function Get-IdentitySnapshot {
    $primary = Get-PrimaryPackage
    if (-not $primary) { throw "Primary OpenAI.ChatGPT-Desktop package is not installed." }
    $primaryRoot = Get-RootProcessForPackage -Package $primary
    $primaryProcess = if ($primaryRoot) { Get-Process -Id $primaryRoot.ProcessId -ErrorAction SilentlyContinue } else { $null }
    $primaryVisible = [bool]($primaryProcess -and $primaryProcess.MainWindowHandle -ne 0)
    $workers = @(Get-WorkerPackages | ForEach-Object { Get-WorkerIdentityRow -Package $_ })
    $interactives = @(Get-InteractivePackages | ForEach-Object { Get-InteractiveIdentityRow -Package $_ })
    $protocol = Get-ProtocolOwner
    $dirty = @($workers | Where-Object { -not $_.Clean })
    $dirtyInteractives = @($interactives | Where-Object { -not $_.Clean })
    $runningWorkers = @($workers | Where-Object { $_.Running })
    $runningInteractives = @($interactives | Where-Object { $_.Running })
    [pscustomobject]@{
        # Clean secondary identities are not enough: a stale/unknown UserChoice is
        # still an identity-health failure because Windows remembers a non-canonical
        # chatgpt:// owner. Only canonical Main-01 may own that global protocol.
        Ok = ($dirty.Count -eq 0 -and $dirtyInteractives.Count -eq 0 -and $protocol.State -eq "primary-current")
        WorkerIsolationSafe = ($dirty.Count -eq 0 -and -not ($protocol.IsWorker -and $protocol.ActiveClaim))
        InteractiveIsolationSafe = ($dirtyInteractives.Count -eq 0 -and -not ($protocol.IsInteractive -and $protocol.ActiveClaim))
        ProtocolCanonical = ($protocol.State -eq "primary-current")
        Primary = [pscustomobject]@{
            PackageName = $primary.Name
            PackageFamilyName = $primary.PackageFamilyName
            Version = [string]$primary.Version
            Running = [bool]$primaryRoot
            Visible = $primaryVisible
            Pid = if ($primaryRoot) { [int]$primaryRoot.ProcessId } else { $null }
            WindowHandle = if ($primaryVisible) { [long]$primaryProcess.MainWindowHandle } else { 0 }
            Alias = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\chatgpt-classic.exe"
            AppUserModelID = "OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0!ChatGPT"
        }
        Protocol = $protocol
        Workers = $workers
        Interactives = $interactives
        DirtyWorkers = @($dirty | ForEach-Object { $_.Number })
        RunningWorkers = @($runningWorkers | ForEach-Object { $_.Number })
        DirtyInteractives = @($dirtyInteractives | ForEach-Object { $_.Number })
        RunningInteractives = @($runningInteractives | ForEach-Object { $_.Number })
        PendingRunningMigration = @($dirty | Where-Object { $_.Running } | ForEach-Object { $_.Number })
    }
}

function Repair-InstalledWorkers {
    if (-not (Test-Path -LiteralPath $cloneScript)) { throw "Runtime clone script is missing: $cloneScript" }
    $results = @()
    foreach ($package in Get-WorkerPackages) {
        $row = Get-WorkerIdentityRow -Package $package
        if ($row.Clean) {
            $results += [pscustomobject]@{ Worker = $row.Number; State = "already-clean"; Running = $row.Running }
            continue
        }
        # Once a running legacy worker has already had its on-disk manifest
        # sanitized, do not keep rewriting it on every periodic heal pass. Its
        # Windows registration is migrated only after the user closes it naturally.
        if ($row.Running -and $row.ManifestClean) {
            $results += [pscustomobject]@{ Worker = $row.Number; State = "pending-running"; Running = $true }
            continue
        }
        $child = Invoke-PowerShellChild -ScriptPath $cloneScript -Arguments @("-Count", "1", "-FirstWorker", [string]$row.Number, "-RepairExisting")
        if ($child.ExitCode -ne 0) {
            $results += [pscustomobject]@{ Worker = $row.Number; State = "repair-failed"; Running = $row.Running; Detail = ($child.Output -join "`n") }
            continue
        }
        $after = Get-WorkerIdentityRow -Package (Get-AppxPackage -Name $package.Name | Sort-Object Version -Descending | Select-Object -First 1)
        $state = if ($row.Running) { "pending-running" } elseif ($after.Clean) { "repaired" } else { "repair-incomplete" }
        if (-not $row.Running -and $after.Clean -and (Test-Path -LiteralPath $controllerScript)) {
            # Auto-protection exists only to keep an interactive/misrouted worker
            # alive until it can be migrated safely. Once the worker is closed and
            # its registered identity is clean, remove that temporary exclusion so
            # the runtime can rejoin the normal pool later.
            try {
                & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $controllerScript -Action unprotect -Worker $row.Number | Out-Null
            }
            catch {}
        }
        $results += [pscustomobject]@{ Worker = $row.Number; State = $state; Running = $row.Running }
    }
    $results
}

function Protect-MisroutedProtocolWorker {
    $owner = Get-ProtocolOwner
    if (-not $owner.IsWorker -or $null -eq $owner.Worker) { return $null }
    $number = [int]$owner.Worker
    $package = Get-AppxPackage -Name ("OpenAI.ChatGPT-Desktop.Worker{0:D2}" -f $number) -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if (-not $package) { return $null }
    $root = Get-RootProcessForPackage -Package $package
    if (-not $root) { return [pscustomobject]@{ Worker = $number; State = "protocol-owner-not-running" } }
    if (-not (Test-Path -LiteralPath $controllerScript)) { throw "Chat Swarm controller is missing: $controllerScript" }
    $child = Invoke-PowerShellChild -ScriptPath $controllerScript -Arguments @("-Action", "protect", "-Worker", [string]$number, "-ProtectionReason", "windows-chatgpt-protocol-default-owner")
    if ($child.ExitCode -ne 0) { throw "Failed to protect misrouted worker-{0:D2}: {1}" -f $number, ($child.Output -join "`n") }
    [pscustomobject]@{ Worker = $number; State = "protected-running-protocol-owner"; Pid = [int]$root.ProcessId }
}

function Ensure-PrimaryRunning {
    param([switch]$NoWindowActivation)
    $primary = Get-PrimaryPackage
    if (-not $primary) { throw "Primary OpenAI.ChatGPT-Desktop package is not installed." }
    $root = Get-RootProcessForPackage -Package $primary
    $process = if ($root) { Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue } else { $null }
    if ($process -and ($NoWindowActivation -or $process.MainWindowHandle -ne 0)) {
        return [pscustomobject]@{ State = if ($process.MainWindowHandle -ne 0) { "already-visible" } else { "already-running-no-activation" }; Pid = [int]$root.ProcessId; WindowHandle = [long]$process.MainWindowHandle }
    }

    # A background primary process is not enough: the original bug left Primary
    # alive but invisible while a worker package owned the only ChatGPT window.
    # Invoking the explicit primary alias activates/creates the primary window
    # without stopping any worker runtime.
    $alias = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\chatgpt-classic.exe"
    if (-not (Test-Path -LiteralPath $alias)) { throw "Primary ChatGPT execution alias is missing: $alias" }
    $launchArguments = if ($NoWindowActivation) { @("--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9721") } else { @() }
    if ($NoWindowActivation) {
        Start-Process -FilePath $alias -ArgumentList $launchArguments -WindowStyle Minimized | Out-Null
    }
    else {
        Start-Process -FilePath $alias | Out-Null
    }
    $deadline = (Get-Date).AddSeconds($PrimaryLaunchWaitSeconds)
    do {
        Start-Sleep -Milliseconds 350
        $root = Get-RootProcessForPackage -Package $primary
        $process = if ($root) { Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue } else { $null }
    } while ((-not $process -or ((-not $NoWindowActivation) -and $process.MainWindowHandle -eq 0)) -and (Get-Date) -lt $deadline)
    if (-not $process -or ((-not $NoWindowActivation) -and $process.MainWindowHandle -eq 0)) { throw "Primary ChatGPT did not expose the required process state before timeout." }
    [pscustomobject]@{ State = if ($NoWindowActivation) { "started-primary-minimized" } else { "activated-primary-window" }; Pid = [int]$root.ProcessId; WindowHandle = [long]$process.MainWindowHandle }
}

function Repair-PrimaryProtocolChoice {
    $before = Get-ProtocolOwner
    if ($before.State -eq "primary-current") {
        return [pscustomobject]@{
            Ok = $true
            State = "already-canonical"
            Before = $before
            After = $before
            UsedSupportedDefaultAppsUi = $false
            ProtectedUserChoiceRegistryEdited = $false
        }
    }

    $primary = Get-PrimaryPackage
    if (-not $primary) { throw "Primary OpenAI.ChatGPT-Desktop package is not installed." }
    $aumid = "$($primary.PackageFamilyName)!ChatGPT"
    $settingsUri = "ms-settings:defaultapps?registeredAUMID={0}" -f [uri]::EscapeDataString($aumid)

    # Windows protects the UserChoice hash. DevSpace intentionally never edits,
    # deletes, or forges that key. Drive the supported Default Apps/OpenWith UI
    # and verify the resulting association through the same read-only audit path.
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DevSpaceProtocolUi {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@ -ErrorAction SilentlyContinue

    $existingOpenWith = @(Get-Process -Name "OpenWith" -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    Start-Process $settingsUri | Out-Null

    $settingsPid = $null
    $associationButton = $null
    $deadline = (Get-Date).AddSeconds([Math]::Max(8, $PrimaryLaunchWaitSeconds))
    do {
        $settingsProcess = Get-Process -Name "SystemSettings" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($settingsProcess) {
            $settingsPid = [int]$settingsProcess.Id
            $condition = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
                $settingsPid
            )
            $elements = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                $condition
            )
            for ($i = 0; $i -lt $elements.Count; $i++) {
                $element = $elements.Item($i)
                if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
                    $element.Current.AutomationId -eq "EntityItemButton" -and
                    $element.Current.Name -like "CHATGPT,*ChatGPT Classic*") {
                    $associationButton = $element
                    break
                }
            }
        }
        if (-not $associationButton) { Start-Sleep -Milliseconds 300 }
    } while (-not $associationButton -and (Get-Date) -lt $deadline)

    if (-not $associationButton) {
        throw "Windows Default Apps UI did not expose the canonical ChatGPT protocol association row."
    }

    $associationButton.SetFocus()
    $invoke = $associationButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $invoke.Invoke()

    $openWith = $null
    $deadline = (Get-Date).AddSeconds([Math]::Max(8, $PrimaryLaunchWaitSeconds))
    do {
        $visible = @(Get-Process -Name "OpenWith" -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne 0 } |
            Sort-Object StartTime -Descending)
        $newVisible = @($visible | Where-Object { $existingOpenWith -notcontains $_.Id } | Select-Object -First 1)
        $openWith = if ($newVisible.Count -gt 0) { $newVisible[0] } elseif ($visible.Count -gt 0) { $visible[0] } else { $null }
        if (-not $openWith) { Start-Sleep -Milliseconds 250 }
    } while (-not $openWith -and (Get-Date) -lt $deadline)

    if (-not $openWith) {
        throw "Windows OpenWith default-app chooser did not appear for chatgpt://."
    }

    $dialogHandle = [IntPtr]::new([long]$openWith.MainWindowHandle)
    [void][DevSpaceProtocolUi]::ShowWindow($dialogHandle, 9)
    [void][DevSpaceProtocolUi]::SetForegroundWindow($dialogHandle)
    Start-Sleep -Milliseconds 250

    # The supported Settings chooser opens with the canonical registered handler
    # as the only ChatGPT-capable app. ENTER selects it; TAB+ENTER commits the
    # default. Every step is bounded and followed by authoritative registry/UI
    # read-back rather than assuming the keystroke succeeded.
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Start-Sleep -Milliseconds 250
    [System.Windows.Forms.SendKeys]::SendWait("{TAB}{ENTER}")

    $after = $null
    $deadline = (Get-Date).AddSeconds([Math]::Max(5, $PrimaryLaunchWaitSeconds))
    do {
        Start-Sleep -Milliseconds 300
        $after = Get-ProtocolOwner
        if ($after.State -eq "primary-current") { break }
    } while ((Get-Date) -lt $deadline)

    if (-not $after -or $after.State -ne "primary-current") {
        throw "Windows Default Apps UI completed without producing canonical Main-01 chatgpt:// ownership."
    }

    # Close the chooser if Windows leaves the interim dialog open. This does not
    # alter the already-committed association.
    try {
        $stillOpen = Get-Process -Id $openWith.Id -ErrorAction SilentlyContinue
        if ($stillOpen -and $stillOpen.MainWindowHandle -ne 0) {
            [void][DevSpaceProtocolUi]::SetForegroundWindow([IntPtr]::new([long]$stillOpen.MainWindowHandle))
            [System.Windows.Forms.SendKeys]::SendWait("%{F4}")
        }
    }
    catch {}

    [pscustomobject]@{
        Ok = $true
        State = "canonical-repaired"
        Before = $before
        After = $after
        UsedSupportedDefaultAppsUi = $true
        ProtectedUserChoiceRegistryEdited = $false
    }
}

function Install-GuardTask {
    if ([string]::IsNullOrWhiteSpace($scriptSelf)) { throw "Unable to resolve runtime identity guard script path." }
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -MultipleInstances IgnoreNew -StartWhenAvailable

    $guardAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ("-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"{0}`" -Action guard -NoWindowActivation" -f $scriptSelf)
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    Register-ScheduledTask -TaskName $taskName -Action $guardAction -Trigger $logonTrigger -Settings $settings -Description "Protect any misrouted ChatGPT worker and start the Primary ChatGPT app without foreground activation; never terminates running workers." -Force | Out-Null

    # Deferred self-heal is intentionally separate from the logon guard. It never
    # opens/closes ChatGPT windows; every ten minutes it only migrates dirty workers
    # that are already stopped. A protected interactive worker therefore heals by
    # itself after the user naturally closes it, without a one-off manual repair.
    $healAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ("-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"{0}`" -Action repair" -f $scriptSelf)
    $healStart = (Get-Date).AddMinutes(2)
    $healTrigger = New-ScheduledTaskTrigger -Once -At $healStart -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)
    Register-ScheduledTask -TaskName $healTaskName -Action $healAction -Trigger $healTrigger -Settings $settings -Description "Deferred non-destructive DevSpace ChatGPT worker identity migration. Running workers are never terminated." -Force | Out-Null

    @(
        Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
        Get-ScheduledTask -TaskName $healTaskName | Select-Object TaskName, State
    )
}

switch ($Action) {
    "audit" {
        Get-IdentitySnapshot | ConvertTo-Json -Depth 8
    }
    "repair" {
        $repair = @(Repair-InstalledWorkers)
        [pscustomobject]@{ Repair = $repair; Snapshot = Get-IdentitySnapshot } | ConvertTo-Json -Depth 10
    }
    "repair-protocol" {
        $repair = Repair-PrimaryProtocolChoice
        [pscustomobject]@{ ProtocolRepair = $repair; Snapshot = Get-IdentitySnapshot } | ConvertTo-Json -Depth 10
    }
    "guard" {
        # Guard is deliberately non-destructive: running workers are never stopped.
        # If Windows still routes chatgpt:// to a running worker, protect that runtime
        # first so no later scale/repair path can terminate the user's interactive UI.
        $misroute = Protect-MisroutedProtocolWorker
        $repair = @(Repair-InstalledWorkers)
        $primary = Ensure-PrimaryRunning -NoWindowActivation:$NoWindowActivation
        [pscustomobject]@{ ProtocolMisroute = $misroute; PrimaryGuard = $primary; Repair = $repair; Snapshot = Get-IdentitySnapshot } | ConvertTo-Json -Depth 10
    }
    "install-guard" {
        Install-GuardTask | ConvertTo-Json -Depth 4
    }
    "remove-guard" {
        foreach ($name in @($taskName, $healTaskName)) {
            if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
                Unregister-ScheduledTask -TaskName $name -Confirm:$false
            }
        }
        [pscustomobject]@{ Removed = $true; Tasks = @($taskName, $healTaskName) } | ConvertTo-Json -Depth 3
    }
}
