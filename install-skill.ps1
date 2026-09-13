[CmdletBinding()]
param(
    [string] $SourceRoot,
    [string] $Repository = "https://raw.githubusercontent.com/enwong93-sketch/devspace-ultra",
    [string] $Ref = "v0.5.7",
    [string] $Destination = (Join-Path $HOME ".codex\skills\devspace-ultra-setup")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-AtomicFile([string] $Path, [byte[]] $Bytes) {
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllBytes($temporary, $Bytes)
    $delay = 8
    while ($true) {
        try {
            Move-Item -LiteralPath $temporary -Destination $Path -Force
            break
        }
        catch {
            if ($_.Exception.HResult -notin @(-2147024891, -2147024864)) { throw }
            Start-Sleep -Milliseconds $delay
            $delay = [Math]::Min(250, [Math]::Ceiling($delay * 1.5))
        }
    }
}

$relativeFiles = @(
    "SKILL.md",
    "agents/openai.yaml"
)

foreach ($relative in $relativeFiles) {
    $target = Join-Path $Destination ($relative -replace '/', '\')
    if ($SourceRoot) {
        $source = Join-Path $SourceRoot ("skills\devspace-ultra-setup\" + ($relative -replace '/', '\'))
        if (-not (Test-Path -LiteralPath $source)) {
            throw "Packaged Skill file is missing: $source"
        }
        Write-AtomicFile $target ([IO.File]::ReadAllBytes($source))
    }
    else {
        $uri = "$($Repository.TrimEnd('/'))/$Ref/skills/devspace-ultra-setup/$relative"
        $temporaryDownload = Join-Path $env:TEMP ("devspace-ultra-skill-" + [guid]::NewGuid().ToString('N'))
        try {
            Invoke-WebRequest -Uri $uri -OutFile $temporaryDownload -UseBasicParsing
            Write-AtomicFile $target ([IO.File]::ReadAllBytes($temporaryDownload))
        }
        finally {
            Remove-Item -LiteralPath $temporaryDownload -Force -ErrorAction SilentlyContinue
        }
    }
}

$skill = Join-Path $Destination "SKILL.md"
if (-not (Test-Path -LiteralPath $skill)) {
    throw "Skill installation did not produce $skill"
}
$text = Get-Content -LiteralPath $skill -Raw
if ($text -notmatch '(?m)^name:\s*devspace-ultra-setup\s*$' -or $text -notmatch 'DuckDNS/DDNS') {
    throw "Installed Skill failed its content check."
}

Write-Host "DevSpace Ultra Setup Skill installed:" -ForegroundColor Green
Write-Host $skill
Write-Host "Ask the Agent to use devspace-ultra-setup for installation, upgrade, DDNS, Cloudflare fallback, or backend repair."
