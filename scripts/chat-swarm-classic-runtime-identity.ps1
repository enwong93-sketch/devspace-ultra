[CmdletBinding()]
param(
    [ValidateSet("audit", "repair", "guard", "install-guard", "remove-guard")]
    [string]$Action = "audit",

    [ValidateRange(0, 120)]
    [int]$PrimaryLaunchWaitSeconds = 12
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
        return [pscustomobject]@{
            State = if ($isPrimary) { "primary-current" } else { "worker-current" }
            ProgId = $progId
            PrimaryProgId = $primaryProgId
            ApplicationName = if ($isPrimary) { "ChatGPT Classic" } else { "ChatGPT Worker {0:D2}" -f [int]$current.Worker }
            AppUserModelID = [string]$current.AppUserModelID
            ActiveClaim = $true
            IsPrimary = $isPrimary
            IsWorker = -not $isPrimary
            Worker = if ($isPrimary) { $null } else { [int]$current.Worker }
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
    $isLegacyPrimary = -not [string]::IsNullOrWhiteSpace($primaryAumid) -and $aumid -eq $primaryAumid
    [pscustomobject]@{
        State = if ($legacyWorker.Success) { "worker-stale" } elseif ($isLegacyPrimary) { "primary-stale" } else { "stale-unknown" }
        ProgId = $progId
        PrimaryProgId = $primaryProgId
        ApplicationName = [string]$application.ApplicationName
        AppUserModelID = $aumid
        ActiveClaim = $false
        IsPrimary = $false
        IsWorker = $legacyWorker.Success
        Worker = if ($legacyWorker.Success) { [int]$legacyWorker.Groups[1].Value } else { $null }
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

function Get-IdentitySnapshot {
    $primary = Get-PrimaryPackage
    if (-not $primary) { throw "Primary OpenAI.ChatGPT-Desktop package is not installed." }
    $primaryRoot = Get-RootProcessForPackage -Package $primary
    $primaryProcess = if ($primaryRoot) { Get-Process -Id $primaryRoot.ProcessId -ErrorAction SilentlyContinue } else { $null }
    $primaryVisible = [bool]($primaryProcess -and $primaryProcess.MainWindowHandle -ne 0)
    $workers = @(Get-WorkerPackages | ForEach-Object { Get-WorkerIdentityRow -Package $_ })
    $protocol = Get-ProtocolOwner
    $dirty = @($workers | Where-Object { -not $_.Clean })
    $runningWorkers = @($workers | Where-Object { $_.Running })
    [pscustomobject]@{
        # A clean worker fleet is not enough: a stale/unknown UserChoice is an
        # identity-health failure because Windows still remembers a non-canonical
        # chatgpt:// owner. We cannot forge the protected UserChoice hash, so the
        # audit reports it explicitly instead of silently treating it as healthy.
        Ok = ($dirty.Count -eq 0 -and $protocol.State -eq "primary-current")
        WorkerIsolationSafe = ($dirty.Count -eq 0 -and -not ($protocol.IsWorker -and $protocol.ActiveClaim))
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
        DirtyWorkers = @($dirty | ForEach-Object { $_.Number })
        RunningWorkers = @($runningWorkers | ForEach-Object { $_.Number })
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
    $primary = Get-PrimaryPackage
    if (-not $primary) { throw "Primary OpenAI.ChatGPT-Desktop package is not installed." }
    $root = Get-RootProcessForPackage -Package $primary
    $process = if ($root) { Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue } else { $null }
    if ($process -and $process.MainWindowHandle -ne 0) {
        return [pscustomobject]@{ State = "already-visible"; Pid = [int]$root.ProcessId; WindowHandle = [long]$process.MainWindowHandle }
    }

    # A background primary process is not enough: the original bug left Primary
    # alive but invisible while a worker package owned the only ChatGPT window.
    # Invoking the explicit primary alias activates/creates the primary window
    # without stopping any worker runtime.
    $alias = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\chatgpt-classic.exe"
    if (-not (Test-Path -LiteralPath $alias)) { throw "Primary ChatGPT execution alias is missing: $alias" }
    Start-Process -FilePath $alias | Out-Null
    $deadline = (Get-Date).AddSeconds($PrimaryLaunchWaitSeconds)
    do {
        Start-Sleep -Milliseconds 350
        $root = Get-RootProcessForPackage -Package $primary
        $process = if ($root) { Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue } else { $null }
    } while ((-not $process -or $process.MainWindowHandle -eq 0) -and (Get-Date) -lt $deadline)
    if (-not $process -or $process.MainWindowHandle -eq 0) { throw "Primary ChatGPT did not expose a visible window before timeout." }
    [pscustomobject]@{ State = "activated-primary-window"; Pid = [int]$root.ProcessId; WindowHandle = [long]$process.MainWindowHandle }
}

function Install-GuardTask {
    if ([string]::IsNullOrWhiteSpace($scriptSelf)) { throw "Unable to resolve runtime identity guard script path." }
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -MultipleInstances IgnoreNew -StartWhenAvailable

    $guardAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ("-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"{0}`" -Action guard" -f $scriptSelf)
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    Register-ScheduledTask -TaskName $taskName -Action $guardAction -Trigger $logonTrigger -Settings $settings -Description "Protect any misrouted ChatGPT worker and explicitly activate the Primary ChatGPT app after logon; never terminates running workers." -Force | Out-Null

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
    "guard" {
        # Guard is deliberately non-destructive: running workers are never stopped.
        # If Windows still routes chatgpt:// to a running worker, protect that runtime
        # first so no later scale/repair path can terminate the user's interactive UI.
        $misroute = Protect-MisroutedProtocolWorker
        $repair = @(Repair-InstalledWorkers)
        $primary = Ensure-PrimaryRunning
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
