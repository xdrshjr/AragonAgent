[CmdletBinding()]
param(
  [switch]$DryRun,

  [string]$CoreRange = '<=0.1.2',

  [string]$CliRange = '<=0.4.2',

  [Parameter(DontShow = $true)]
  [string]$NpmCommand = 'npm'
)

# Deprecates the packages published under the misspelled @argon-agent scope, so
# that every `npm install` of them prints a one-line pointer at the renamed ones.
# Both CHANGELOGs already promise this ("@argon-agent/* is deprecated"); until
# now nothing in the toolchain could actually deliver on it.
#
# Why this is a separate script rather than a switch on publish-latest.ps1:
#   (a) it acts on a DIFFERENT scope, unrelated to the release script's pre/post
#       condition model;
#   (b) it is idempotent and can be re-run on its own at any later time, while a
#       release is a one-shot;
#   (c) folding it into the release path would let a failed deprecate pollute the
#       answer to "did the publish succeed?", and those two questions are not in
#       the same severity class.
#
# Run it only AFTER the replacements are live. Step 2 enforces that.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# Pinned for the same measured reason as the Node tools: this machine's default
# registry is a mirror, and a mirror's answer about `deprecated` (step 5) or about
# whether the replacement exists (step 2) can differ from npmjs.org's. Turning the
# "the replacement is ready" safety precondition into a coin flip is not acceptable.
$registry = 'https://registry.npmjs.org/'

$legacyCore = '@argon-agent/core'
$legacyCli = '@argon-agent/cli'
$replacementCore = '@aragon-agent/core'
$replacementCli = '@aragon-agent/cli'

# Printed on every install of a deprecated version, so: short, actionable, ASCII only.
#
# Single quotes around the letters, not double, and that is load-bearing rather
# than a style choice. PowerShell 5.1 strips embedded double quotes when it hands
# an argument to a native command — measured here: a message containing "a"
# reaches the callee as a, with no warning and no non-zero exit. The registry
# would then carry silently mangled prose forever, since a deprecation message is
# published metadata.
$coreMessage = 'Renamed to @aragon-agent/core (this scope was missing an ''a''). No further releases here. See https://github.com/xdrshjr/AragonAgent'
$cliMessage = 'Renamed to @aragon-agent/cli: npm i -g @aragon-agent/cli (the ''aragon'' command is unchanged). No further releases here.'

$npmExecutable = $NpmCommand
$npmPrefixArguments = @()

# Same Windows npm resolution as publish-latest.ps1:40-49 — `npm` is a shim, and
# spawning it without a shell is either ENOENT or (for npm.cmd, since Node's
# CVE-2024-27980 fix) EINVAL. Resolve node.exe + npm-cli.js instead.
if ($NpmCommand -eq 'npm' -and $env:OS -eq 'Windows_NT') {
  $npmCmd = Get-Command 'npm.cmd' -CommandType Application -ErrorAction Stop
  $npmCli = Join-Path (Split-Path -Parent $npmCmd.Source) 'node_modules\npm\bin\npm-cli.js'
  if (-not (Test-Path -LiteralPath $npmCli)) {
    throw "Unable to find npm-cli.js next to npm.cmd: $npmCli"
  }
  $nodeCommand = Get-Command 'node.exe' -CommandType Application -ErrorAction Stop
  $npmExecutable = $nodeCommand.Source
  $npmPrefixArguments = @($npmCli)
}

function Invoke-NpmCommand {
  param([string[]]$Arguments)

  Write-Host "> npm $($Arguments -join ' ')" -ForegroundColor DarkGray
  $commandArguments = @($npmPrefixArguments) + @($Arguments)
  if ([IO.Path]::GetExtension($npmExecutable) -eq '.ps1') {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $npmExecutable @commandArguments
  } else {
    & $npmExecutable @commandArguments
  }
  if ($LASTEXITCODE -ne 0) {
    throw "npm command failed ($LASTEXITCODE): npm $($Arguments -join ' ')"
  }
}

function Invoke-NpmCapture {
  param([string[]]$Arguments)

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $commandArguments = @($npmPrefixArguments) + @($Arguments)
    if ([IO.Path]::GetExtension($npmExecutable) -eq '.ps1') {
      $output = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $npmExecutable @commandArguments 2>&1)
    } else {
      $output = @(& $npmExecutable @commandArguments 2>&1)
    }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  return [pscustomobject]@{
    ExitCode = $exitCode
    Output = $output
    Text = ($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
  }
}

function Get-CapturedValue($Result) {
  return ($Result.Output | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_.Length -gt 0 } | Select-Object -Last 1)
}

# '<=0.1.2' -> '0.1.2'. The read-back in step 5 needs a concrete version.
function ConvertTo-ConcreteVersion([string]$Range) {
  $version = ($Range -replace '^[\s<>=^~v]+', '').Trim()
  if ($version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Cannot derive a concrete version from range '$Range'; expected something like '<=0.1.2'"
  }
  return $version
}

function Assert-NpmAuthentication {
  $result = Invoke-NpmCapture @('whoami', '--registry', $registry)
  if ($result.ExitCode -ne 0) {
    throw @"
Not authenticated against $registry, so npm deprecate would fail.
Log in, then re-run this script:
  npm login --scope "@aragon-agent" --registry "$registry" --auth-type web
npm reported:
$($result.Text)
"@
  }
  Write-Host "npm account: $(Get-CapturedValue $result)" -ForegroundColor DarkGray
}

# The core safety property of this script. Pushing users off a package that works
# and onto one that does not exist is worse than not deprecating at all.
function Assert-ReplacementPublished([string]$PackageName) {
  $result = Invoke-NpmCapture @('view', $PackageName, 'version', '--registry', $registry)
  if ($result.ExitCode -eq 0) {
    Write-Host "Replacement ready: $PackageName@$(Get-CapturedValue $result)" -ForegroundColor DarkGray
    return
  }
  if ($result.Text -match '(?i)E404|404\s+Not\s+Found|is not in this registry') {
    throw "Refusing to deprecate: replacement $PackageName is not published yet."
  }
  throw "Unable to query $PackageName from npm:`n$($result.Text)"
}

function Assert-Deprecated([string]$PackageName, [string]$Version, [string]$ExpectedMessage) {
  $specifier = "$PackageName@$Version"
  $result = Invoke-NpmCapture @('view', $specifier, 'deprecated', '--registry', $registry)
  if ($result.ExitCode -ne 0) {
    throw "Unable to read back the deprecation of ${specifier}:`n$($result.Text)"
  }
  $actual = Get-CapturedValue $result
  if ([string]::IsNullOrWhiteSpace($actual)) {
    throw "$specifier still reports no deprecation message after npm deprecate."
  }
  if ($actual -ne $ExpectedMessage) {
    throw "$specifier reports deprecation message '$actual', expected '$ExpectedMessage'"
  }
  Write-Host "Verified: $specifier is deprecated." -ForegroundColor DarkGray
}

Push-Location $PSScriptRoot
try {
  $coreVersion = ConvertTo-ConcreteVersion $CoreRange
  $cliVersion = ConvertTo-ConcreteVersion $CliRange

  Assert-NpmAuthentication
  Assert-ReplacementPublished $replacementCore
  Assert-ReplacementPublished $replacementCli

  $coreArguments = @('deprecate', "$legacyCore@$CoreRange", $coreMessage, '--registry', $registry)
  $cliArguments = @('deprecate', "$legacyCli@$CliRange", $cliMessage, '--registry', $registry)

  if ($DryRun) {
    Write-Host 'Dry run; the following commands were NOT executed:' -ForegroundColor Yellow
    Write-Host "  npm deprecate `"$legacyCore@$CoreRange`" `"$coreMessage`" --registry $registry"
    Write-Host "  npm deprecate `"$legacyCli@$CliRange`" `"$cliMessage`" --registry $registry"
    Write-Host 'Dry run completed; nothing was written to the registry.' -ForegroundColor Green
    exit 0
  }

  Invoke-NpmCommand $coreArguments
  Invoke-NpmCommand $cliArguments

  Assert-Deprecated $legacyCore $coreVersion $coreMessage
  Assert-Deprecated $legacyCli $cliVersion $cliMessage

  Write-Host "Deprecated $legacyCore@$CoreRange and $legacyCli@$CliRange." -ForegroundColor Green
  Write-Host "Re-run 'npm run verify:published -- --core <v> --cli <v>' to confirm V5."
} finally {
  Pop-Location
}
