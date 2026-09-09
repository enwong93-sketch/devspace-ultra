[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $CloudflaredPath,
    [Parameter(Mandatory)] [string] $SecretPath,
    [Parameter(Mandatory)] [string] $RuntimeDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Read-ProtectedSecret([string] $Path) {
    $secure = Get-Content -LiteralPath $Path -Raw | ConvertTo-SecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

New-Item -ItemType Directory -Path $RuntimeDirectory -Force | Out-Null
$tokenFile = Join-Path $RuntimeDirectory "cloudflared-token-$PID.txt"
$token = Read-ProtectedSecret $SecretPath
try {
    [IO.File]::WriteAllText($tokenFile, $token, [Text.UTF8Encoding]::new($false))
    $acl = Get-Acl -LiteralPath $tokenFile
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        [Security.Principal.WindowsIdentity]::GetCurrent().Name,
        "FullControl",
        "Allow"
    )
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $tokenFile -AclObject $acl
    & $CloudflaredPath --no-autoupdate tunnel run --token-file $tokenFile
    exit $LASTEXITCODE
}
finally {
    $token = $null
    Remove-Item -LiteralPath $tokenFile -Force -ErrorAction SilentlyContinue
}
