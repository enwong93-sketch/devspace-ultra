[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$TargetAlias,

    [ValidateRange(10, 300)]
    [int]$WaitSeconds = 120,

    [ValidateRange(100, 2000)]
    [int]$PollMilliseconds = 400
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Web

if (-not (Test-Path -LiteralPath $TargetAlias)) {
    throw "Interactive ChatGPT target alias does not exist."
}

function Get-DesktopAuthUrl {
    # A single Chrome process can own multiple top-level browser windows, while
    # Get-Process.MainWindowHandle exposes only one of them. Enumerate the desktop
    # accessibility roots instead so the auth completion page can be found in any
    # visible Chrome/Edge window without reading browser profile data.
    $desktop = [System.Windows.Automation.AutomationElement]::RootElement
    $topLevel = $desktop.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($window in $topLevel) {
        try {
            $processId = [int]$window.Current.ProcessId
            if ($processId -le 0) { continue }
            $browser = Get-Process -Id $processId -ErrorAction SilentlyContinue
            if (-not $browser) { continue }
            $processName = [string]$browser.ProcessName
            if ($processName -notin @("chrome", "msedge")) { continue }

            $edits = $window.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.PropertyCondition]::new(
                    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                    [System.Windows.Automation.ControlType]::Edit
                )
            )
            foreach ($element in $edits) {
                $value = ""
                try {
                    $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                    $value = [string]$pattern.Current.Value
                }
                catch { continue }
                if ($value -notmatch "chatgpt\.com/auth/open_in_desktop") { continue }
                if ($value -notmatch "^https?://") { $value = "https://$value" }
                return [pscustomobject]@{
                    Url = $value
                    Browser = $processName
                    BrowserPid = $processId
                }
            }
        }
        catch {
            # Browser accessibility trees can change while tabs/windows move.
            # Ignore one stale top-level window and continue scanning the others.
            continue
        }
    }
    return $null
}

function Get-CallbackFromCompletionUrl {
    param([Parameter(Mandatory)][string]$Url)

    try { $completion = [Uri]$Url }
    catch { throw "Interactive auth completion URL was invalid." }
    if ($completion.Scheme -ne "https" -or $completion.Host -ne "chatgpt.com" -or $completion.AbsolutePath -ne "/auth/open_in_desktop") {
        throw "Interactive auth completion URL did not match the expected ChatGPT endpoint."
    }

    $query = [System.Web.HttpUtility]::ParseQueryString($completion.Query)
    $path = [string]$query["path"]
    $code = [string]$query["code"]
    $state = [string]$query["state"]
    if ([string]::IsNullOrWhiteSpace($path) -or [string]::IsNullOrWhiteSpace($code) -or [string]::IsNullOrWhiteSpace($state)) {
        throw "Interactive auth completion URL was missing required callback fields."
    }
    if ($path -notmatch '^/api/auth/callback/openai-sidetron(?:-dev)?$') {
        throw "Interactive auth callback path was not allowlisted."
    }

    # The current ChatGPT web route constructs this exact Windows callback from
    # path + code + state. Build it locally from the already-loaded completion URL
    # instead of refetching a browser-session-bound page. The one-time values stay
    # in memory and are never printed or written to disk.
    $prefix = "chatgpt://oauth_complete"
    $encodedCode = [Uri]::EscapeDataString($code)
    $encodedState = [Uri]::EscapeDataString($state)
    return ('{0}{1}?code={2}&state={3}' -f $prefix, $path, $encodedCode, $encodedState)
}

$deadline = (Get-Date).AddSeconds($WaitSeconds)
$found = $null
while ((Get-Date) -lt $deadline -and -not $found) {
    $found = Get-DesktopAuthUrl
    if (-not $found) { Start-Sleep -Milliseconds $PollMilliseconds }
}

if (-not $found) {
    [pscustomobject]@{
        Ok = $false
        Relayed = $false
        Reason = "desktop-auth-page-timeout"
        SecretMaterialLogged = $false
    } | ConvertTo-Json -Depth 3 -Compress
    exit 4
}

$callback = Get-CallbackFromCompletionUrl -Url $found.Url
# Keep the one-time callback only in memory. Launching the explicit target alias
# bypasses Windows' single global chatgpt:// owner and therefore cannot redirect
# this Interactive login into canonical Main-01.
Start-Process -FilePath $TargetAlias -ArgumentList @($callback) | Out-Null
$callback = $null

[pscustomobject]@{
    Ok = $true
    Relayed = $true
    Browser = $found.Browser
    BrowserPid = $found.BrowserPid
    SecretMaterialLogged = $false
    WindowsDefaultChanged = $false
} | ConvertTo-Json -Depth 3 -Compress
