[CmdletBinding()]
param(
    [ValidateRange(1, 32)]
    [int]$Count = 1,

    [ValidateRange(1, 32)]
    [int]$FirstWorker = 1,

    [switch]$ForceRefresh,

    [switch]$RepairExisting,

    [switch]$Launch
)

$ErrorActionPreference = "Stop"

function Save-Utf8Xml {
    param(
        [Parameter(Mandatory)] [xml]$Document,
        [Parameter(Mandatory)] [string]$Path
    )
    $settings = [System.Xml.XmlWriterSettings]::new()
    $settings.Encoding = [System.Text.UTF8Encoding]::new($false)
    $settings.Indent = $true
    $settings.NewLineChars = "`r`n"
    $settings.NewLineHandling = [System.Xml.NewLineHandling]::Replace
    $writer = [System.Xml.XmlWriter]::Create($Path, $settings)
    try { $Document.Save($writer) }
    finally { $writer.Dispose() }
}

function Remove-XmlNodes {
    param(
        [Parameter(Mandatory)] [xml]$Document,
        [Parameter(Mandatory)] [System.Xml.XmlNamespaceManager]$NamespaceManager,
        [Parameter(Mandatory)] [string]$XPath
    )
    $nodes = @($Document.SelectNodes($XPath, $NamespaceManager))
    foreach ($node in $nodes) {
        [void]$node.ParentNode.RemoveChild($node)
    }
}

function Update-WorkerManifest {
    param(
        [Parameter(Mandatory)] [string]$ManifestPath,
        [Parameter(Mandatory)] [string]$PackageName,
        [Parameter(Mandatory)] [string]$DisplayName,
        [Parameter(Mandatory)] [string]$AliasName
    )

    [xml]$manifest = Get-Content -LiteralPath $ManifestPath -Raw
    $ns = [System.Xml.XmlNamespaceManager]::new($manifest.NameTable)
    $ns.AddNamespace("f", "http://schemas.microsoft.com/appx/manifest/foundation/windows10")
    $ns.AddNamespace("uap", "http://schemas.microsoft.com/appx/manifest/uap/windows10")
    $ns.AddNamespace("uap3", "http://schemas.microsoft.com/appx/manifest/uap/windows10/3")
    $ns.AddNamespace("uap5", "http://schemas.microsoft.com/appx/manifest/uap/windows10/5")
    $ns.AddNamespace("uap10", "http://schemas.microsoft.com/appx/manifest/uap/windows10/10")
    $ns.AddNamespace("desktop", "http://schemas.microsoft.com/appx/manifest/desktop/windows10")

    $identity = $manifest.SelectSingleNode("/f:Package/f:Identity", $ns)
    if (-not $identity) { throw "Clone manifest is missing Package/Identity." }
    $identity.SetAttribute("Name", $PackageName)

    # Give workers a different Application Id from Primary. Package identity alone
    # is not enough because Windows taskbar/default-app artifacts can persist an
    # AUMID (PackageFamily!ApplicationId). Keeping !ChatGPT on worker packages let
    # stale pins/protocol choices continue targeting a worker after the global
    # protocol extension itself had been removed. Only Primary may own !ChatGPT.
    $application = $manifest.SelectSingleNode("/f:Package/f:Applications/f:Application", $ns)
    if (-not $application) { throw "Clone manifest is missing Package/Applications/Application." }
    $application.SetAttribute("Id", "DevSpaceWorker")

    $propertyDisplayName = $manifest.SelectSingleNode("/f:Package/f:Properties/f:DisplayName", $ns)
    if ($propertyDisplayName) { $propertyDisplayName.InnerText = $DisplayName }
    $propertyDescription = $manifest.SelectSingleNode("/f:Package/f:Properties/f:Description", $ns)
    if ($propertyDescription) { $propertyDescription.InnerText = "$DisplayName runtime clone" }

    $visual = $manifest.SelectSingleNode("/f:Package/f:Applications/f:Application/uap:VisualElements", $ns)
    if ($visual) {
        $visual.SetAttribute("DisplayName", $DisplayName)
        $visual.SetAttribute("Description", "$DisplayName runtime clone")
        # Worker runtimes are backend-controlled infrastructure, not user-facing
        # launcher targets. Hiding them from the app list prevents accidental
        # manual/default launches from competing with the primary ChatGPT app.
        $visual.SetAttribute("AppListEntry", "none")
    }

    $defaultTile = $manifest.SelectSingleNode("/f:Package/f:Applications/f:Application/uap:VisualElements/uap:DefaultTile", $ns)
    if ($defaultTile) { $defaultTile.SetAttribute("ShortName", $DisplayName) }

    $executionAlias = $manifest.SelectSingleNode("//uap3:Extension[@Category='windows.appExecutionAlias']//desktop:ExecutionAlias", $ns)
    if (-not $executionAlias) { throw "Clone manifest is missing the ChatGPT app execution alias." }
    $executionAlias.SetAttribute("Alias", $AliasName)

    # Worker clones must never register any global launch surface owned by the
    # primary ChatGPT installation. In particular, retaining chatgpt:// can make
    # Windows select a worker package as the user's default ChatGPT handler after
    # reboot/deep-link activation. Startup and Copilot-key ownership are primary-only.
    # The separate DevSpaceWorker Application Id also invalidates legacy !ChatGPT
    # worker AUMIDs retained by old taskbar pins or default-app artifacts.
    Remove-XmlNodes -Document $manifest -NamespaceManager $ns -XPath "//uap:Extension[@Category='windows.protocol']"
    Remove-XmlNodes -Document $manifest -NamespaceManager $ns -XPath "//uap5:Extension[@Category='windows.startupTask']"
    Remove-XmlNodes -Document $manifest -NamespaceManager $ns -XPath "//uap3:Extension[@Category='windows.appExtension']"
    Remove-XmlNodes -Document $manifest -NamespaceManager $ns -XPath "/f:Package/f:Properties/uap10:PackageIntegrity"

    Save-Utf8Xml -Document $manifest -Path $ManifestPath
}

if ($RepairExisting -and $ForceRefresh) {
    throw "-RepairExisting is an in-place migration mode and cannot be combined with -ForceRefresh."
}

$sourcePackage = Get-AppxPackage -Name "OpenAI.ChatGPT-Desktop" |
    Sort-Object Version -Descending |
    Select-Object -First 1

if (-not $sourcePackage) {
    throw "OpenAI ChatGPT Classic package is not installed for the current user."
}

$sourceRoot = $sourcePackage.InstallLocation
$sourceVersion = [string]$sourcePackage.Version
$runtimeRoot = Join-Path $env:LOCALAPPDATA ("ChatGPT-Classic-Worker-Runtimes\" + $sourceVersion)
$results = @()

for ($offset = 0; $offset -lt $Count; $offset++) {
    $number = $FirstWorker + $offset
    $workerId = "worker-{0:D2}" -f $number
    $suffix = "Worker{0:D2}" -f $number
    $packageName = "OpenAI.ChatGPT-Desktop.$suffix"
    $displayName = "ChatGPT Worker {0:D2}" -f $number
    $aliasName = "chatgpt-classic-worker{0:D2}.exe" -f $number
    $cloneRoot = Join-Path $runtimeRoot $workerId
    $manifestPath = Join-Path $cloneRoot "AppxManifest.xml"

    $existingClone = Get-AppxPackage -Name $packageName -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1

    $needsCopy = $ForceRefresh -or -not (Test-Path -LiteralPath $manifestPath)
    if ($needsCopy) {
        if (Test-Path -LiteralPath $cloneRoot) {
            Remove-Item -LiteralPath $cloneRoot -Recurse -Force
        }
        New-Item -ItemType Directory -Path $cloneRoot -Force | Out-Null
        Copy-Item -Path (Join-Path $sourceRoot "*") -Destination $cloneRoot -Recurse -Force

        # A registered loose-file development package should not retain the
        # Store package's signature/block-map/integrity catalogue after its
        # manifest identity has been changed.
        foreach ($artifact in @("AppxSignature.p7x", "AppxBlockMap.xml")) {
            $artifactPath = Join-Path $cloneRoot $artifact
            if (Test-Path -LiteralPath $artifactPath) {
                Remove-Item -LiteralPath $artifactPath -Force
            }
        }
        $metadataPath = Join-Path $cloneRoot "AppxMetadata"
        if (Test-Path -LiteralPath $metadataPath) {
            Remove-Item -LiteralPath $metadataPath -Recurse -Force
        }

        Update-WorkerManifest -ManifestPath $manifestPath -PackageName $packageName -DisplayName $displayName -AliasName $aliasName
    }
    elseif ($RepairExisting) {
        # Migrate old already-installed clones without deleting the package,
        # process, or profile. This is safe to attempt on a running worker and
        # is the preferred path for protocol/startup identity cleanup.
        Update-WorkerManifest -ManifestPath $manifestPath -PackageName $packageName -DisplayName $displayName -AliasName $aliasName
    }

    $registrationState = "registered"
    $runningClone = $false
    if ($existingClone) {
        $runningClone = [bool](Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                $_.ExecutablePath -and
                $_.ExecutablePath.StartsWith($existingClone.InstallLocation, [System.StringComparison]::OrdinalIgnoreCase)
            } |
            Select-Object -First 1)
    }

    if ($RepairExisting -and $existingClone -and $runningClone) {
        # Never unregister or re-register a worker while it may own a live ChatGPT
        # conversation. The sanitized manifest remains staged on disk and a later
        # identity-repair pass will activate it once the runtime is inactive.
        $registrationState = "pending-running"
        $registered = $existingClone
    }
    else {
        if ($existingClone) {
            # These workers are loose-file registered development packages. Preserve
            # their package data explicitly across identity re-registration so a
            # manifest/AUMID repair cannot erase the isolated ChatGPT profile/session.
            Remove-AppxPackage -Package $existingClone.PackageFullName -PreserveApplicationData -ErrorAction Stop
            Start-Sleep -Milliseconds 500
        }
        Add-AppxPackage -Register $manifestPath -ErrorAction Stop
        $registered = Get-AppxPackage -Name $packageName -ErrorAction Stop |
            Sort-Object Version -Descending |
            Select-Object -First 1
        $registrationState = if ($RepairExisting) { "repaired" } else { "registered" }
    }

    $launchResult = "not-requested"
    if ($Launch) {
        $aliasPath = Join-Path $env:LOCALAPPDATA ("Microsoft\WindowsApps\" + $aliasName)
        if (-not (Test-Path -LiteralPath $aliasPath)) {
            throw "Worker alias was not registered: $aliasPath"
        }
        Start-Process -FilePath $aliasPath | Out-Null
        $launchResult = "started"
    }

    $results += [pscustomobject]@{
        WorkerId = $workerId
        PackageName = $packageName
        PackageFullName = $registered.PackageFullName
        InstallLocation = $registered.InstallLocation
        Alias = $aliasName
        Mode = if ($RepairExisting) { "repair-existing" } elseif ($ForceRefresh) { "force-refresh" } else { "register" }
        Registration = $registrationState
        Running = $runningClone
        Launch = $launchResult
    }
}

$results | Format-Table WorkerId, PackageName, Alias, Mode, Registration, Running, Launch -AutoSize
