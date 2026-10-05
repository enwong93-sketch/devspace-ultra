$ErrorActionPreference = 'Stop'
function Import-TestFunctions {
    param([string]$Path, [string[]]$Names)
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'Script parse failed' }
    foreach ($name in $Names) {
        $node = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
        if ($node) { . ([scriptblock]::Create($node.Extent.Text)); Set-Item "Function:script:$name" (Get-Item "Function:$name").ScriptBlock }
    }
}
function Assert-Test { param([bool]$Value, [string]$Message) if (-not $Value) { throw $Message } }
Import-TestFunctions (Join-Path $PSScriptRoot 'chat-classic-session-source.ps1') @('Get-RuntimeDebugPort', 'Get-InteractiveCandidate', 'Get-WorkerCandidate')
$interactiveDebugBasePort = 9730; $workerDebugBasePort = 9330
$script:root = [pscustomobject]@{ ProcessId = 3068; CommandLine = '"chatgpt-classic-main05.exe" --remote-debugging-address=127.0.0.1 --remote-debugging-port=19735' }
$script:listenerPid = 3068; $script:listenerAddress = '127.0.0.1'; $script:probePort = $null
function Get-AppxPackage { param($Name, $ErrorAction) [pscustomobject]@{ Name = $Name; InstallLocation = 'C:\fixture'; PackageFamilyName = 'fixture-profile'; Version = '1.0' } }
function Get-RootProcessForExecutable { param($ExecutablePath) $script:root }
function Get-NetTCPConnection { param($State, $LocalPort, $ErrorAction) [pscustomobject]@{ OwningProcess = $script:listenerPid; LocalAddress = $script:listenerAddress; LocalPort = $LocalPort } }
function Test-SignedInPort { param($Port) $script:probePort = $Port; $true }
$candidate = Get-InteractiveCandidate -Number 5
Assert-Test ($candidate.DebugPort -eq 19735 -and $script:probePort -eq 19735) 'Legacy Main must probe the observed port, not static 9735'
$script:root.CommandLine = 'worker.exe --remote-debugging-address=127.0.0.1 --remote-debugging-port=19431'
$candidate = Get-WorkerCandidate -Number 1
Assert-Test ($candidate.DebugPort -eq 19431) 'Worker must use its observed, owned port'
$script:listenerPid = 9999
Assert-Test ($null -eq (Get-InteractiveCandidate -Number 5)) 'Foreign listener must not provide session credentials'
$script:listenerPid = 3068; $script:listenerAddress = '0.0.0.0'
Assert-Test ($null -eq (Get-InteractiveCandidate -Number 5)) 'Non-loopback listener must not become a source'
$script:listenerAddress = '127.0.0.1'; $script:root.CommandLine = 'main.exe --remote-debugging-port=99999'
Assert-Test ($null -eq (Get-InteractiveCandidate -Number 5)) 'Invalid observed port must not fall back to a different source'
$script:root.CommandLine = 'main.exe --remote-debugging-port=invalid'
Assert-Test ($null -eq (Get-InteractiveCandidate -Number 5)) 'Malformed observed port must not authorize a static fallback'
$script:root.CommandLine = 'main.exe --remote-debugging-port=99999999999999999999999999'
Assert-Test ($null -eq (Get-InteractiveCandidate -Number 5)) 'Overflowing port must fail closed without crashing discovery'
$script:root.CommandLine = 'main.exe'
$candidate = Get-InteractiveCandidate -Number 5
Assert-Test ($candidate.DebugPort -eq 9735) 'Missing port flag retains only the PID-verified canonical fallback'
$script:root = $null
Assert-Test ($null -eq (Get-InteractiveCandidate -Number 5)) 'A stopped package must be skipped without a mandatory-parameter error'
Assert-Test ($null -eq (Get-WorkerCandidate -Number 1)) 'A stopped worker must be skipped without a mandatory-parameter error'

Import-TestFunctions (Join-Path $PSScriptRoot 'chat-classic-interactive-runtime.ps1') @('Start-InteractiveRuntime')
$VerifyTimeoutSeconds = 0
function Test-Path { param($LiteralPath) $true }
function Start-Process { param($FilePath, $ArgumentList, $WindowStyle, $WorkingDirectory) $script:launchStyle = $WindowStyle }
function Start-Sleep { param($Milliseconds) }
function Test-TcpPort { param($Port) $script:portReady }
function Get-InteractiveRuntime { param($Number) $script:current }
$initial = [pscustomobject]@{ Registered = $true; Running = $false; Number = 7; Label = 'Main-07'; AliasPath = 'fixture.exe'; DebugPort = 9737 }
$script:current = [pscustomobject]@{ Running = $true; Visible = $false; DebugPort = 9737 }
$StartMinimized = $true; $script:portReady = $true
$started = Start-InteractiveRuntime -Runtime $initial
Assert-Test ($started.Running -and $script:launchStyle -eq 'Minimized') 'Minimized runtime with a ready port must start without a visible-window requirement'
$script:portReady = $false; $rejected = $false
try { $null = Start-InteractiveRuntime -Runtime $initial } catch { $rejected = $true }
Assert-Test $rejected 'Minimized runtime still requires its verification port'
$StartMinimized = $false; $script:portReady = $true; $rejected = $false
try { $null = Start-InteractiveRuntime -Runtime $initial } catch { $rejected = $true }
Assert-Test $rejected 'Normal interactive launch retains its visible-window requirement'
Import-TestFunctions (Join-Path $PSScriptRoot 'chat-classic-interactive-runtime.ps1') @('Test-InteractiveSignedIn')
$script:probeReads = 0
$script:probes = @([pscustomobject]@{composer=$false;loginVisible=$false}, [pscustomobject]@{composer=$true;composerDisabled=$false;loginVisible=$false})
function Invoke-InteractiveProbe { param($Runtime) $script:probeReads++; $script:probes[[Math]::Min($script:probeReads - 1, $script:probes.Count - 1)] }
$VerifyTimeoutSeconds = 1
$authentication = Test-InteractiveSignedIn -Runtime $initial
Assert-Test ($authentication.SignedIn -and $script:probeReads -eq 2) 'Cold startup must wait for authentication readiness instead of declaring a lost session from the first loading snapshot'
$VerifyTimeoutSeconds = 0; $script:probeReads = 0
$script:probes = @([pscustomobject]@{composer=$true;composerDisabled=$true;loginVisible=$false})
Assert-Test (Test-InteractiveSignedIn -Runtime $initial).SignedIn 'Active assistant work must not cause reseeding of an already signed-in runtime'
$script:probeReads = 0; $script:probes = @([pscustomobject]@{composer=$true;composerDisabled=$false;loginVisible=$false;accountExpired=$true})
Assert-Test (-not (Test-InteractiveSignedIn -Runtime $initial).SignedIn) 'Expired account must not pass authentication readiness'
Write-Output '{"ok":true,"gate":"classic-session-source","legacyPorts":true,"listenerPidVerified":true,"loopbackOnly":true,"minimizedReadiness":true}'
