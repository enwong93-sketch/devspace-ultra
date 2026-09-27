$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$installer = Join-Path (Split-Path $PSScriptRoot -Parent) 'install.ps1'
. $installer

function Assert-True($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Assert-Throws([scriptblock]$Action, [string]$Message) {
    $threw = $false
    try { & $Action } catch { $threw = $true }
    Assert-True $threw $Message
}

$tag = 'v0.5.10'
$name = 'devspace-ultra-0.5.10.tgz'
$digest = 'sha256:' + ('a' * 64)
$url = "https://github.com/enwong93-sketch/devspace-ultra/releases/download/$tag/$name"
$release = [pscustomobject]@{
    tag_name = $tag
    draft = $false
    prerelease = $false
    assets = @([pscustomobject]@{ name=$name; digest=$digest; browser_download_url=$url })
}
$selected = Select-ReleaseArchiveAsset -Release $release -Tag $tag
Assert-True ($selected.Name -eq $name -and $selected.Version -eq '0.5.10') 'Exact stable archive selection failed.'
Assert-True ($selected.Digest -eq ('a' * 64) -and $selected.Url -eq $url) 'Release digest or URL changed unexpectedly.'

$bad = $release | ConvertTo-Json -Depth 6 | ConvertFrom-Json
$bad.draft = $true
Assert-Throws { Select-ReleaseArchiveAsset -Release $bad -Tag $tag } 'Draft release must be rejected.'
$bad = $release | ConvertTo-Json -Depth 6 | ConvertFrom-Json
$bad.assets[0].digest = ''
Assert-Throws { Select-ReleaseArchiveAsset -Release $bad -Tag $tag } 'Missing digest must be rejected.'
$bad = $release | ConvertTo-Json -Depth 6 | ConvertFrom-Json
$bad.assets[0].browser_download_url = 'https://example.invalid/archive.tgz'
Assert-Throws { Select-ReleaseArchiveAsset -Release $bad -Tag $tag } 'Foreign release asset URL must be rejected.'
$bad = $release | ConvertTo-Json -Depth 6 | ConvertFrom-Json
$bad.assets = @($bad.assets[0], $bad.assets[0])
Assert-Throws { Select-ReleaseArchiveAsset -Release $bad -Tag $tag } 'Duplicate matching assets must be rejected.'
Assert-Throws { Select-ReleaseArchiveAsset -Release $release -Tag 'main' } 'Moving branch names must not be accepted as a stable tag.'

[pscustomobject]@{ ok=$true; gate='windows-installer-release-selection'; exactTag=$tag; testedNoNetwork=$true } | ConvertTo-Json -Compress
