$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$env:DEVSPACE_UPDATE_LIBRARY_ONLY = '1'
try { . (Join-Path (Split-Path $PSScriptRoot -Parent) 'update.ps1') }
finally { Remove-Item Env:DEVSPACE_UPDATE_LIBRARY_ONLY -ErrorAction SilentlyContinue }
$script:TestMode = $false
$script:StopCalls = 0
$script:GatewayReads = 0
$script:FlipPid = $false
$script:Offline = $false
$script:DiagnosticFailure = $false
$script:RestoreCalls = 0
$script:Core = [pscustomobject]@{ ok=$true; pid=1234; registries=[pscustomobject]@{ processSessions=1 } }
$script:Gateway = [pscustomobject]@{
    ok=$true; activePid=1234; handoverInProgress=$false; coreRecoveryInProgress=$false
    runtimeIdentityMismatch=$null; fatalHandoverError=$null
    admission=[pscustomobject]@{ activeRequests=1 }
    sessions=[pscustomobject]@{ totalNonStreamActiveRequests=0 }
}
function Test-Path { return $true }
function Get-Content { return '{"gatewayPort":7678,"controlToken":"fixture-only"}' }
function Invoke-RestMethod {
    param($Uri, $Headers, $Method, [switch]$UseBasicParsing)
    if ($script:DiagnosticFailure) { throw 'Fixture diagnostics unavailable' }
    if ($Uri -like '*/__devspace/memory/status') { return $script:Core }
    $script:GatewayReads++
    if ($script:FlipPid -and $script:GatewayReads % 2 -eq 0) {
        $copy = $script:Gateway | ConvertTo-Json -Depth 5 | ConvertFrom-Json
        $copy.activePid = 9999
        return $copy
    }
    return $script:Gateway
}
function Test-UpdateRuntimeAbsent { return $script:Offline }
function Stop-Process { $script:StopCalls++; throw 'No process may be stopped in this test' }
function Get-CimInstance { throw 'No production process inventory permitted in a busy stop test' }
function Restore-RuntimeTaskActions { $script:RestoreCalls++ }
function Restart-PreviousRuntime { $script:RestoreCalls++ }
function Assert-True($Value, [string]$Message) { if (-not $Value) { throw $Message } }

$busy = Get-GatewayBusyState
Assert-True $busy.Busy 'HTTP quiet must not permit update while Core retains process output/work.'
foreach ($invalid in @($null, -1, 0.5, '0', $true)) {
    $script:Core.registries.processSessions = $invalid
    Assert-True (Get-GatewayBusyState).Busy 'Invalid process count must defer update.'
}
$script:Core.registries.processSessions = 0
$script:Core.pid = 9999
Assert-True (Get-GatewayBusyState).Busy 'Wrong Core PID must defer update.'
$script:Core.pid = 1234
$script:Core.ok = $false
Assert-True (Get-GatewayBusyState).Busy 'Unhealthy Core must defer update.'
$script:Core.ok = $true
$script:Gateway.handoverInProgress = $true
Assert-True (Get-GatewayBusyState).Busy 'An in-flight handover must defer update.'
$script:Gateway.handoverInProgress = $false
$script:Gateway.sessions.totalNonStreamActiveRequests = 1
Assert-True (Get-GatewayBusyState).Busy 'An active tool must defer update.'
$script:Gateway.sessions.totalNonStreamActiveRequests = 0
Assert-True (-not (Get-GatewayBusyState).Busy) 'Exact healthy PID with zero retained sessions/tools should be ready.'
$script:GatewayReads = 0
$script:FlipPid = $true
Assert-True (Get-GatewayBusyState).Busy 'Core ownership changing during the readiness probe must defer update.'
$script:FlipPid = $false
$savedRegistries = $script:Core.registries
$script:Core.registries = [pscustomobject]@{}
Assert-True (Get-GatewayBusyState).Busy 'Missing process diagnostics must defer update.'
$script:Core.registries = $savedRegistries
$script:DiagnosticFailure = $true
Assert-True (Get-GatewayBusyState).Busy 'Failed diagnostics on a live runtime must defer update.'
$script:Offline = $true
Assert-True (-not (Get-GatewayBusyState).Busy) 'Verified offline installation may proceed without live diagnostics.'
$script:Offline = $false
$script:DiagnosticFailure = $false

# Work can appear after staging. The retirement boundary must check again
# before inspecting/killing processes or touching Scheduled Tasks, even -Force.
$script:Core.registries.processSessions = 1
$script:Force = $true
$threw = $false
try { Stop-DevSpaceRuntime -PackageRecords @() -TaskSnapshot @() } catch {
    $threw = $_.Exception.Message -like 'Runtime retirement deferred:*'
}
Assert-True ($threw -and $script:StopCalls -eq 0) 'Retirement must refuse late work without side effects.'
Restore-RetiredUpdateRuntime -TaskSnapshot @()
Assert-True ($script:RestoreCalls -eq 0 -and -not $script:RuntimeRetirementStarted) 'A readiness deferral must not restart or rewrite live tasks in rollback.'
$script:RuntimeRetirementStarted = $true
Restore-RetiredUpdateRuntime -TaskSnapshot @()
Assert-True ($script:RestoreCalls -eq 2) 'Actual retirement still needs task restoration on rollback.'
Write-Output '{"ok":true,"gate":"self-update-process-readiness","productionChanged":false}'
