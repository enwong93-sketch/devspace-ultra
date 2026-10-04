$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$env:DEVSPACE_UPDATE_LIBRARY_ONLY='1'
try { . (Join-Path (Split-Path $PSScriptRoot -Parent) 'update.ps1') }
finally { Remove-Item Env:DEVSPACE_UPDATE_LIBRARY_ONLY -ErrorAction SilentlyContinue }
function Assert-True($value,[string]$message){if(-not $value){throw $message}}
Assert-True ($null -eq (Get-PrimaryInstalledRecord $null)) 'An empty/new npm prefix is not an installed-package object.'
Assert-True ($null -eq (Get-PrimaryInstalledRecord @())) 'An empty package inventory must not crash under StrictMode.'
$root='C:\fixture\node_modules\devspace-ultra'
$rows=@(
  [pscustomobject]@{ProcessId=10;ParentProcessId=1;Name='node.exe';CommandLine="node $root\scripts\devspace-stable-gateway.mjs"},
  [pscustomobject]@{ProcessId=11;ParentProcessId=10;Name='node.exe';CommandLine="node $root\dist\cli.js serve"},
  [pscustomobject]@{ProcessId=20;ParentProcessId=1;Name='node.exe';CommandLine="node $root\scripts\devspace-local-ingress.mjs"},
  [pscustomobject]@{ProcessId=21;ParentProcessId=20;Name='caddy.exe';CommandLine='caddy run --config C:\fixture\Caddyfile'},
  [pscustomobject]@{ProcessId=30;ParentProcessId=1;Name='ChatGPT Classic.exe';CommandLine='fixture protected Classic'},
  [pscustomobject]@{ProcessId=31;ParentProcessId=30;Name='node.exe';CommandLine='fixture protected child'},
  [pscustomobject]@{ProcessId=40;ParentProcessId=1;Name='node.exe';CommandLine='node C:\fixture\chat-to-codex\scripts\shared-mcp-service.mjs'}
)
$plan=Get-UpdateRuntimeProcessPlan -Roots @($root) -Processes $rows -UpdaterPid 999
Assert-True (($plan.StopProcessIds -join ',') -eq '11,10') 'Stop only owned Core/Gateway, children first.'
Assert-True ($plan.ProtectedDescendantConflict -eq $false) 'Unrelated/shared runtime must remain untouched.'
$reversed=@($rows);[array]::Reverse($reversed)
$plan=Get-UpdateRuntimeProcessPlan -Roots @($root) -Processes $reversed -UpdaterPid 999
Assert-True (($plan.StopProcessIds -join ',') -eq '11,10') 'CIM row order must not put a parent before its child.'
$quoted=@([pscustomobject]@{ProcessId=60;ParentProcessId=1;Name='node.exe';CommandLine=('node "'+$root+'\dist\cli.js" serve')},
  [pscustomobject]@{ProcessId=61;ParentProcessId=1;Name='node.exe';CommandLine=('node '+$root+'-other\dist\cli.js serve')})
$plan=Get-UpdateRuntimeProcessPlan -Roots @($root) -Processes $quoted -UpdaterPid 999
Assert-True (($plan.StopProcessIds -join ',') -eq '60') 'Match an exact quoted package path, not a sibling prefix.'
Assert-True ((Test-PreservedUpdateTask 'DevSpace-Local-Ingress') -and (Test-PreservedUpdateTask 'DevSpace-Canonical-Startup')) 'Preserve ingress and native-runtime launch tasks.'
$bad=@($rows)+[pscustomobject]@{ProcessId=50;ParentProcessId=11;Name='ChatGPT Classic.exe';CommandLine='fixture unexpectedly adopted app'}
$plan=Get-UpdateRuntimeProcessPlan -Roots @($root) -Processes $bad -UpdaterPid 999
Assert-True $plan.ProtectedDescendantConflict 'Refuse retirement if an owned tree contains a protected app.'
Write-Output '{"ok":true,"gate":"self-update-shared-runtime-preservation","productionChanged":false}'
