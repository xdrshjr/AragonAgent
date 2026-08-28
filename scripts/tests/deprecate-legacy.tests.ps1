$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# Fixture tests for deprecate-legacy.ps1, in the same Assert-* style as
# publish-latest.tests.ps1 and driven by the same fake-npm.ps1.
#
# D3 is the one that matters most: pushing users off a package that works and
# onto one that does not exist yet is strictly worse than not deprecating at all,
# so the replacement-exists precondition must refuse BEFORE any write.

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$deprecateScript = Join-Path $projectRoot 'deprecate-legacy.ps1'
$fakeNpm = Join-Path $PSScriptRoot 'fake-npm.ps1'

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) {
    throw "Assertion failed: $Message"
  }
}

function Assert-Equal($Expected, $Actual, [string]$Message) {
  if ($Expected -ne $Actual) {
    throw "Assertion failed: $Message. Expected '$Expected', got '$Actual'."
  }
}

function Write-Json([string]$Path, $Value) {
  $Value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Path -Encoding utf8
}

function New-DeprecateFixture([string[]]$PublishedCore = @(), [string[]]$PublishedCli = @()) {
  $base = Join-Path ([IO.Path]::GetTempPath()) ("aragon-deprecate-test-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $base | Out-Null
  $log = Join-Path $base 'npm-log.jsonl'
  $state = Join-Path $base 'npm-state.json'
  New-Item -ItemType File -Path $log | Out-Null
  Write-Json $state ([ordered]@{ core = @($PublishedCore); cli = @($PublishedCli) })
  return [pscustomobject]@{ Base = $base; Log = $log; State = $state }
}

function Invoke-DeprecateFixture($Fixture, [string[]]$Arguments, [switch]$Unauthenticated) {
  $previousLog = $env:ARAGON_FAKE_NPM_LOG
  $previousState = $env:ARAGON_FAKE_NPM_STATE
  $previousUnauthenticated = $env:ARAGON_FAKE_NPM_UNAUTHENTICATED
  try {
    $env:ARAGON_FAKE_NPM_LOG = $Fixture.Log
    $env:ARAGON_FAKE_NPM_STATE = $Fixture.State
    $env:ARAGON_FAKE_NPM_UNAUTHENTICATED = if ($Unauthenticated) { '1' } else { $null }
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = & powershell -NoProfile -ExecutionPolicy Bypass -File $deprecateScript @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    return [pscustomobject]@{ ExitCode = $exitCode; Output = @($output) }
  } finally {
    $ErrorActionPreference = 'Stop'
    $env:ARAGON_FAKE_NPM_LOG = $previousLog
    $env:ARAGON_FAKE_NPM_STATE = $previousState
    $env:ARAGON_FAKE_NPM_UNAUTHENTICATED = $previousUnauthenticated
  }
}

function Get-LoggedCommands($Fixture) {
  return @(
    Get-Content -LiteralPath $Fixture.Log -Encoding utf8 |
      Where-Object { $_.Trim().Length -gt 0 } |
      ForEach-Object { ((ConvertFrom-Json $_).args -join ' ') }
  )
}

function Assert-CommandLike($Commands, [string]$Pattern) {
  Assert-True (@($Commands | Where-Object { $_ -like $Pattern }).Count -gt 0) `
    "missing npm command like '$Pattern'; got: $($Commands -join ' | ')"
}

function Assert-NoDeprecateCall($Commands) {
  Assert-True (-not ($Commands | Where-Object { $_ -like 'deprecate *' })) `
    "a deprecate call was made when none was expected; got: $($Commands -join ' | ')"
}

if (-not (Test-Path -LiteralPath $deprecateScript)) {
  throw "Deprecate script does not exist: $deprecateScript"
}

$fixtures = @()
try {
  Write-Host '[deprecate-test] D1 dry run prints both commands and writes nothing'
  $dryFixture = New-DeprecateFixture -PublishedCore @('0.2.0') -PublishedCli @('0.5.0')
  $fixtures += $dryFixture
  $dryResult = Invoke-DeprecateFixture $dryFixture @('-DryRun', '-NpmCommand', $fakeNpm)
  Assert-Equal 0 $dryResult.ExitCode ($dryResult.Output -join [Environment]::NewLine)
  $dryText = ($dryResult.Output | ForEach-Object { $_.ToString() }) -join "`n"
  Assert-True ($dryText -match 'npm deprecate "@argon-agent/core@<=0\.1\.2"') 'dry run did not print the Core command'
  Assert-True ($dryText -match 'npm deprecate "@argon-agent/cli@<=0\.4\.2"') 'dry run did not print the CLI command'
  Assert-NoDeprecateCall (Get-LoggedCommands $dryFixture)

  Write-Host '[deprecate-test] D2 real run deprecates both and reads the result back'
  $runFixture = New-DeprecateFixture -PublishedCore @('0.2.0') -PublishedCli @('0.5.0')
  $fixtures += $runFixture
  $runResult = Invoke-DeprecateFixture $runFixture @('-NpmCommand', $fakeNpm)
  Assert-Equal 0 $runResult.ExitCode ($runResult.Output -join [Environment]::NewLine)
  $runCommands = Get-LoggedCommands $runFixture
  Assert-CommandLike $runCommands 'deprecate @argon-agent/core@<=0.1.2 *--registry https://registry.npmjs.org/'
  Assert-CommandLike $runCommands 'deprecate @argon-agent/cli@<=0.4.2 *--registry https://registry.npmjs.org/'
  # The read-back is what turns "npm exited 0" into "the registry actually says so".
  Assert-CommandLike $runCommands 'view @argon-agent/core@0.1.2 deprecated --registry https://registry.npmjs.org/'
  Assert-CommandLike $runCommands 'view @argon-agent/cli@0.4.2 deprecated --registry https://registry.npmjs.org/'
  # PowerShell 5.1 drops embedded double quotes from native-command arguments, so
  # the message uses single quotes; assert they survive the whole round trip.
  Assert-CommandLike $runCommands "*missing an 'a'*"

  Write-Host '[deprecate-test] D3 refuses while the replacement is unpublished'
  $missingFixture = New-DeprecateFixture
  $fixtures += $missingFixture
  $missingResult = Invoke-DeprecateFixture $missingFixture @('-NpmCommand', $fakeNpm)
  Assert-True ($missingResult.ExitCode -ne 0) 'deprecate ran without a published replacement'
  $missingText = ($missingResult.Output | ForEach-Object { $_.ToString() }) -join "`n"
  Assert-True ($missingText -match 'Refusing to deprecate') 'missing replacement did not explain itself'
  Assert-NoDeprecateCall (Get-LoggedCommands $missingFixture)

  Write-Host '[deprecate-test] D4 refuses when npm is not authenticated'
  $authFixture = New-DeprecateFixture -PublishedCore @('0.2.0') -PublishedCli @('0.5.0')
  $fixtures += $authFixture
  $authResult = Invoke-DeprecateFixture $authFixture @('-NpmCommand', $fakeNpm) -Unauthenticated
  Assert-True ($authResult.ExitCode -ne 0) 'unauthenticated deprecate unexpectedly succeeded'
  $authText = ($authResult.Output | ForEach-Object { $_.ToString() }) -join "`n"
  Assert-True ($authText -match 'npm login') 'auth failure did not point at npm login'
  Assert-NoDeprecateCall (Get-LoggedCommands $authFixture)

  Write-Host '[deprecate-test] PASS (4 scenarios)'
} finally {
  foreach ($fixture in $fixtures) {
    if ($fixture -and (Test-Path -LiteralPath $fixture.Base)) {
      Remove-Item -LiteralPath $fixture.Base -Recurse -Force
    }
  }
}
