[CmdletBinding()]
param(
    [ValidateRange(1, 32)]
    [int]$Worker = 1,

    [ValidateSet("enable", "disable")]
    [string]$Mode = "enable",

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

$suffix = "Worker{0:D2}" -f $Worker
$workerId = "worker-{0:D2}" -f $Worker
$workerPackageName = "OpenAI.ChatGPT-Desktop.$suffix"
$aliasName = "chatgpt-classic-worker{0:D2}.exe" -f $Worker

$sourcePackage = Get-AppxPackage -Name "OpenAI.ChatGPT-Desktop" |
    Sort-Object Version -Descending |
    Select-Object -First 1
$workerPackage = Get-AppxPackage -Name $workerPackageName |
    Sort-Object Version -Descending |
    Select-Object -First 1

if (-not $sourcePackage) { throw "Primary ChatGPT Classic package is not installed." }
if (-not $workerPackage) { throw "$workerId runtime clone is not registered." }

$sourceManifestPath = Join-Path $sourcePackage.InstallLocation "AppxManifest.xml"
$workerManifestPath = Join-Path $workerPackage.InstallLocation "AppxManifest.xml"

[xml]$sourceManifest = Get-Content -LiteralPath $sourceManifestPath -Raw
[xml]$workerManifest = Get-Content -LiteralPath $workerManifestPath -Raw

$sourceNs = [System.Xml.XmlNamespaceManager]::new($sourceManifest.NameTable)
$sourceNs.AddNamespace("f", "http://schemas.microsoft.com/appx/manifest/foundation/windows10")
$sourceNs.AddNamespace("uap", "http://schemas.microsoft.com/appx/manifest/uap/windows10")

$workerNs = [System.Xml.XmlNamespaceManager]::new($workerManifest.NameTable)
$workerNs.AddNamespace("f", "http://schemas.microsoft.com/appx/manifest/foundation/windows10")
$workerNs.AddNamespace("uap", "http://schemas.microsoft.com/appx/manifest/uap/windows10")

$workerExtensions = $workerManifest.SelectSingleNode("/f:Package/f:Applications/f:Application/f:Extensions", $workerNs)
if (-not $workerExtensions) { throw "Worker manifest has no Application/Extensions element." }

$workerProtocolNodes = @($workerManifest.SelectNodes("//uap:Extension[@Category='windows.protocol']", $workerNs))

if ($Mode -eq "enable") {
    if ($workerProtocolNodes.Count -eq 0) {
        $sourceProtocol = $sourceManifest.SelectSingleNode("//uap:Extension[@Category='windows.protocol']", $sourceNs)
        if (-not $sourceProtocol) { throw "Primary ChatGPT manifest has no windows.protocol extension." }
        $imported = $workerManifest.ImportNode($sourceProtocol, $true)
        [void]$workerExtensions.PrependChild($imported)
    }
}
else {
    foreach ($node in $workerProtocolNodes) {
        [void]$node.ParentNode.RemoveChild($node)
    }
}

# Stop only this clone. The primary ChatGPT process has a different executable path.
$workerExe = Join-Path $workerPackage.InstallLocation "app\ChatGPT Classic.exe"
$workerProcesses = @(
    Get-CimInstance Win32_Process |
        Where-Object { $_.Name -eq "ChatGPT Classic.exe" -and $_.ExecutablePath -eq $workerExe }
)
foreach ($process in $workerProcesses) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 700

Save-Utf8Xml -Document $workerManifest -Path $workerManifestPath

# Re-register the same loose development package. Windows may reject an
# in-place contract change with 0x80073CFB (ResourceExists), so fall back to a
# registration reset that explicitly preserves application data.
try {
    Add-AppxPackage -Register $workerManifestPath -ForceApplicationShutdown -ErrorAction Stop
}
catch {
    $message = $_.Exception.Message
    if ($message -notmatch "0x80073CFB|ResourceExists|already installed|already exists") {
        throw
    }
    $current = Get-AppxPackage -Name $workerPackageName |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if ($current) {
        Remove-AppxPackage -Package $current.PackageFullName -PreserveApplicationData -ErrorAction Stop
        Start-Sleep -Milliseconds 700
    }
    Add-AppxPackage -Register $workerManifestPath -ForceApplicationShutdown -ErrorAction Stop
}

$registered = Get-AppxPackage -Name $workerPackageName |
    Sort-Object Version -Descending |
    Select-Object -First 1

$protocolPresent = $false
[xml]$verifyManifest = Get-Content -LiteralPath (Join-Path $registered.InstallLocation "AppxManifest.xml") -Raw
$verifyNs = [System.Xml.XmlNamespaceManager]::new($verifyManifest.NameTable)
$verifyNs.AddNamespace("uap", "http://schemas.microsoft.com/appx/manifest/uap/windows10")
$protocolPresent = $null -ne $verifyManifest.SelectSingleNode("//uap:Extension[@Category='windows.protocol']", $verifyNs)

if ($Launch) {
    $aliasPath = Join-Path $env:LOCALAPPDATA ("Microsoft\WindowsApps\" + $aliasName)
    if (-not (Test-Path -LiteralPath $aliasPath)) { throw "Worker alias is missing: $aliasPath" }
    Start-Process -FilePath $aliasPath -WorkingDirectory $env:LOCALAPPDATA | Out-Null
}

[pscustomobject]@{
    WorkerId = $workerId
    Mode = $Mode
    ProtocolRegistered = $protocolPresent
    PackageFullName = $registered.PackageFullName
    ProfilePath = Join-Path $env:LOCALAPPDATA ("Packages\" + $registered.PackageFamilyName + "\LocalCache\Roaming\ChatGPT")
    Launched = [bool]$Launch
} | Format-List
