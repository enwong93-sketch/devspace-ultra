[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet("worker", "interactive")]
    [string]$Role,

    [ValidateRange(1, 32)]
    [int]$Count = 1,

    [ValidateRange(1, 32)]
    [int]$FirstNumber = 1,

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

function Get-RoleDescriptor {
    param([Parameter(Mandatory)][int]$Number)

    $padded = "{0:D2}" -f $Number
    if ($Role -eq "worker") {
        return [pscustomobject]@{
            Role = "worker"
            Number = $Number
            RuntimeId = "worker-$padded"
            Label = "Runtime-$padded"
            PackageName = "OpenAI.ChatGPT-Desktop.Worker$padded"
            DisplayName = "ChatGPT Worker $padded"
            ApplicationId = "DevSpaceWorker"
            AliasName = "chatgpt-classic-worker$padded.exe"
            RuntimeRootName = "ChatGPT-Classic-Worker-Runtimes"
            HiddenFromAppList = $true
        }
    }

    if ($Number -eq 1) {
        throw "Main-01 is the canonical Primary and cannot be provisioned with role=interactive."
    }
    [pscustomobject]@{
        Role = "interactive"
        Number = $Number
        RuntimeId = "interactive-$padded"
        Label = "Main-$padded"
        PackageName = "OpenAI.ChatGPT-Desktop.Interactive$padded"
        DisplayName = "ChatGPT Main $padded"
        ApplicationId = "DevSpaceInteractive"
        AliasName = "chatgpt-classic-main$padded.exe"
        RuntimeRootName = "ChatGPT-Classic-Interactive-Runtimes"
        HiddenFromAppList = $false
    }
}

function Update-RoleManifest {
    param(
        [Parameter(Mandatory)] [string]$ManifestPath,
        [Parameter(Mandatory)] $Descriptor
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
    if (-not $identity) { throw "Runtime clone manifest is missing Package/Identity." }
    $identity.SetAttribute("Name", $Descriptor.PackageName)

    $application = $manifest.SelectSingleNode("/f:Package/f:Applications/f:Application", $ns)
    if (-not $application) { throw "Runtime clone manifest is missing Package/Applications/Application." }
    $application.SetAttribute("Id", $Descriptor.ApplicationId)

    $propertyDisplayName = $manifest.SelectSingleNode("/f:Package/f:Properties/f:DisplayName", $ns)
    if ($propertyDisplayName) { $propertyDisplayName.InnerText = $Descriptor.DisplayName }
    $propertyDescription = $manifest.SelectSingleNode("/f:Package/f:Properties/f:Description", $ns)
    if ($propertyDescription) { $propertyDescription.InnerText = "$($Descriptor.DisplayName) runtime clone" }

    $visual = $manifest.SelectSingleNode("/f:Package/f:Applications/f:Application/uap:VisualElements", $ns)
    if ($visual) {
        $visual.SetAttribute("DisplayName", $Descriptor.DisplayName)
        $visual.SetAttribute("Description", "$($Descriptor.DisplayName) runtime clone")
        if ($Role -eq "worker") {
            $visual.SetAttribute("AppListEntry", "none")
        }
        elseif ($Role -eq "interactive") {
            if ($visual.HasAttribute("AppListEntry")) { $visual.RemoveAttribute("AppListEntry") }
        }
    }

    $defaultTile = $manifest.SelectSingleNode("/f:Package/f:Applications/f:Application/uap:VisualElements/uap:DefaultTile", $ns)
    if ($defaultTile) { $defaultTile.SetAttribute("ShortName", $Descriptor.DisplayName) }

    $executionAlias = $manifest.SelectSingleNode("//uap3:Extension[@Category='windows.appExecutionAlias']//desktop:ExecutionAlias", $ns)
    if (-not $executionAlias) { throw "Runtime clone manifest is missing the ChatGPT app execution alias." }
    $executionAlias.SetAttribute("Alias", $Descriptor.AliasName)

    # Only canonical Main-01 may own global ChatGPT launch surfaces. Worker and
    # secondary interactive roles get distinct Application Ids and aliases but
    # never register chatgpt://, startup, or the Copilot-key app extension.
    Remove-XmlNodes -Document $manifest -NamespaceManager $ns -XPath "//uap:Extension[@Category='windows.protocol']"
    Remove-XmlNodes -Document $manifest -NamespaceManager $ns -XPath "//uap5:Extension[@Category='windows.startupTask']"
    Remove-XmlNodes -Document $manifest -NamespaceManager $ns -XPath "//uap3:Extension[@Category='windows.appExtension']"
    Remove-XmlNodes -Document $manifest -NamespaceManager $ns -XPath "/f:Package/f:Properties/uap10:PackageIntegrity"

    Save-Utf8Xml -Document $manifest -Path $ManifestPath
}

if ($RepairExisting -and $ForceRefresh) {
    throw "-RepairExisting is an in-place migration mode and cannot be combined with -ForceRefresh."
}
if (($FirstNumber + $Count - 1) -gt 32) {
    throw "Requested runtime range exceeds 32."
}
if ($Role -eq "interactive" -and $FirstNumber -lt 2) {
    throw "role=interactive starts at Main-02; Main-01 is the canonical Primary."
}

$sourcePackage = Get-AppxPackage -Name "OpenAI.ChatGPT-Desktop" |
    Sort-Object Version -Descending |
    Select-Object -First 1
if (-not $sourcePackage) {
    throw "OpenAI ChatGPT Classic package is not installed for the current user."
}

$sourceRoot = $sourcePackage.InstallLocation
$sourceVersion = [string]$sourcePackage.Version
$results = @()

for ($offset = 0; $offset -lt $Count; $offset++) {
    $number = $FirstNumber + $offset
    $descriptor = Get-RoleDescriptor -Number $number
    $runtimeRoot = Join-Path $env:LOCALAPPDATA ($descriptor.RuntimeRootName + "\" + $sourceVersion)
    $cloneRoot = Join-Path $runtimeRoot $descriptor.RuntimeId
    $manifestPath = Join-Path $cloneRoot "AppxManifest.xml"

    $existingClone = Get-AppxPackage -Name $descriptor.PackageName -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1

    $runningClone = $false
    if ($existingClone) {
        $runningClone = [bool](Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object {
                $_.ExecutablePath -and
                $_.ExecutablePath.StartsWith($existingClone.InstallLocation, [System.StringComparison]::OrdinalIgnoreCase)
            } |
            Select-Object -First 1)
    }

    if ($Role -eq "interactive" -and $runningClone -and ($ForceRefresh -or $RepairExisting)) {
        throw "$($descriptor.Label) is an interactive runtime and is currently running; refusing package refresh/re-registration."
    }

    $needsCopy = $ForceRefresh -or -not (Test-Path -LiteralPath $manifestPath)
    if ($needsCopy) {
        if (Test-Path -LiteralPath $cloneRoot) {
            Remove-Item -LiteralPath $cloneRoot -Recurse -Force
        }
        New-Item -ItemType Directory -Path $cloneRoot -Force | Out-Null
        Copy-Item -Path (Join-Path $sourceRoot "*") -Destination $cloneRoot -Recurse -Force

        foreach ($artifact in @("AppxSignature.p7x", "AppxBlockMap.xml")) {
            $artifactPath = Join-Path $cloneRoot $artifact
            if (Test-Path -LiteralPath $artifactPath) { Remove-Item -LiteralPath $artifactPath -Force }
        }
        $metadataPath = Join-Path $cloneRoot "AppxMetadata"
        if (Test-Path -LiteralPath $metadataPath) { Remove-Item -LiteralPath $metadataPath -Recurse -Force }

        Update-RoleManifest -ManifestPath $manifestPath -Descriptor $descriptor
    }
    elseif ($RepairExisting) {
        Update-RoleManifest -ManifestPath $manifestPath -Descriptor $descriptor
    }

    $registrationState = "registered"
    if ($RepairExisting -and $existingClone -and $runningClone) {
        $registrationState = "pending-running"
        $registered = $existingClone
    }
    elseif ($existingClone -and -not $needsCopy -and -not $RepairExisting) {
        $registered = $existingClone
        $registrationState = "already-registered"
    }
    else {
        if ($existingClone) {
            Remove-AppxPackage -Package $existingClone.PackageFullName -PreserveApplicationData -ErrorAction Stop
            Start-Sleep -Milliseconds 500
        }
        Add-AppxPackage -Register $manifestPath -ErrorAction Stop
        $registered = Get-AppxPackage -Name $descriptor.PackageName -ErrorAction Stop |
            Sort-Object Version -Descending |
            Select-Object -First 1
        $registrationState = if ($RepairExisting) { "repaired" } elseif ($ForceRefresh) { "refreshed" } else { "registered" }
    }

    $launchResult = "not-requested"
    if ($Launch) {
        $aliasPath = Join-Path $env:LOCALAPPDATA ("Microsoft\WindowsApps\" + $descriptor.AliasName)
        if (-not (Test-Path -LiteralPath $aliasPath)) { throw "Runtime alias was not registered: $aliasPath" }
        Start-Process -FilePath $aliasPath | Out-Null
        $launchResult = "started"
    }

    $results += [pscustomobject]@{
        Role = $Role
        Number = $number
        RuntimeId = $descriptor.RuntimeId
        WorkerId = if ($Role -eq "worker") { $descriptor.RuntimeId } else { $null }
        Label = $descriptor.Label
        PackageName = $descriptor.PackageName
        PackageFullName = $registered.PackageFullName
        PackageFamilyName = $registered.PackageFamilyName
        ApplicationId = $descriptor.ApplicationId
        InstallLocation = $registered.InstallLocation
        Alias = $descriptor.AliasName
        CloneRoot = $cloneRoot
        ProfilePath = Join-Path $env:LOCALAPPDATA ("Packages\{0}\LocalCache\Roaming\ChatGPT" -f $registered.PackageFamilyName)
        Mode = if ($RepairExisting) { "repair-existing" } elseif ($ForceRefresh) { "force-refresh" } else { "register" }
        Registration = $registrationState
        Running = $runningClone
        Launch = $launchResult
        HiddenFromAppList = $descriptor.HiddenFromAppList
        WorkerManaged = ($Role -eq "worker")
    }
}

$results
