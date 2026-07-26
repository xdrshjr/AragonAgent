$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$releaseScript = Join-Path $projectRoot 'publish-latest.ps1'
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

function Read-Json([string]$Path) {
  return Get-Content -Raw -LiteralPath $Path -Encoding utf8 | ConvertFrom-Json
}

function New-ReleaseFixture(
  [string]$CoreVersion = '0.1.0',
  [string]$CliVersion = '0.2.0',
  [string]$CoreRange = '^0.1.0',
  [string[]]$PublishedCore = @(),
  [string[]]$PublishedCli = @()
) {
  $base = Join-Path ([IO.Path]::GetTempPath()) ("argon-release-test-" + [guid]::NewGuid().ToString('N'))
  $repo = Join-Path $base 'repo'
  New-Item -ItemType Directory -Force -Path (Join-Path $repo 'packages\core') | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $repo 'packages\cli') | Out-Null

  Write-Json (Join-Path $repo 'package.json') ([ordered]@{
    name = 'release-fixture'
    private = $true
    workspaces = @('packages/*')
  })
  Write-Json (Join-Path $repo 'packages\core\package.json') ([ordered]@{
    name = '@argon-agent/core'
    version = $CoreVersion
  })
  Write-Json (Join-Path $repo 'packages\cli\package.json') ([ordered]@{
    name = '@argon-agent/cli'
    version = $CliVersion
    bin = [ordered]@{ aragon = './dist/cli.js' }
    dependencies = [ordered]@{ '@argon-agent/core' = $CoreRange }
  })
  Write-Json (Join-Path $repo 'package-lock.json') ([ordered]@{
    name = 'release-fixture'
    lockfileVersion = 3
    packages = [ordered]@{
      'packages/core' = [ordered]@{ name = '@argon-agent/core'; version = $CoreVersion }
      'packages/cli' = [ordered]@{
        name = '@argon-agent/cli'
        version = $CliVersion
        bin = [ordered]@{ aragon = 'dist/cli.js' }
        dependencies = [ordered]@{ '@argon-agent/core' = $CoreRange }
      }
    }
  })
  '.worktrees/', 'dist/' | Set-Content -LiteralPath (Join-Path $repo '.gitignore') -Encoding ascii
  Copy-Item -LiteralPath $releaseScript -Destination (Join-Path $repo 'publish-latest.ps1')

  $log = Join-Path $base 'npm-log.jsonl'
  $state = Join-Path $base 'npm-state.json'
  New-Item -ItemType File -Path $log | Out-Null
  Write-Json $state ([ordered]@{ core = @($PublishedCore); cli = @($PublishedCli) })

  & git -C $repo init --quiet
  if ($LASTEXITCODE -ne 0) { throw 'Failed to initialize fixture repository' }
  & git -C $repo config user.name 'Release Test'
  & git -C $repo config user.email 'release-test@example.invalid'
  & git -C $repo add .
  & git -C $repo commit --quiet -m 'fixture'
  if ($LASTEXITCODE -ne 0) { throw 'Failed to commit fixture repository' }

  return [pscustomobject]@{ Base = $base; Repo = $repo; Log = $log; State = $state }
}

function Invoke-ReleaseFixture($Fixture, [string[]]$Arguments, [switch]$Unauthenticated) {
  $previousLog = $env:ARGON_FAKE_NPM_LOG
  $previousState = $env:ARGON_FAKE_NPM_STATE
  $previousUnauthenticated = $env:ARGON_FAKE_NPM_UNAUTHENTICATED
  try {
    $env:ARGON_FAKE_NPM_LOG = $Fixture.Log
    $env:ARGON_FAKE_NPM_STATE = $Fixture.State
    $env:ARGON_FAKE_NPM_UNAUTHENTICATED = if ($Unauthenticated) { '1' } else { $null }
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Fixture.Repo 'publish-latest.ps1') @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    return [pscustomobject]@{ ExitCode = $exitCode; Output = @($output) }
  } finally {
    $ErrorActionPreference = 'Stop'
    $env:ARGON_FAKE_NPM_LOG = $previousLog
    $env:ARGON_FAKE_NPM_STATE = $previousState
    $env:ARGON_FAKE_NPM_UNAUTHENTICATED = $previousUnauthenticated
  }
}

function Get-LoggedCommands($Fixture) {
  return @(
    Get-Content -LiteralPath $Fixture.Log -Encoding utf8 |
      Where-Object { $_.Trim().Length -gt 0 } |
      ForEach-Object { ((ConvertFrom-Json $_).args -join ' ') }
  )
}

function Assert-Command($Commands, [string]$Expected) {
  Assert-True ($Commands -contains $Expected) "missing npm command '$Expected'; got: $($Commands -join ' | ')"
}

if (-not (Test-Path -LiteralPath $releaseScript)) {
  throw "Release script does not exist: $releaseScript"
}

$fixtures = @()
try {
  Write-Host '[release-test] default patch dry-run'
  $patchFixture = New-ReleaseFixture
  $fixtures += $patchFixture
  $patchResult = Invoke-ReleaseFixture $patchFixture @('-DryRun', '-NpmCommand', $fakeNpm)
  Assert-Equal 0 $patchResult.ExitCode ($patchResult.Output -join [Environment]::NewLine)
  Assert-True (($patchResult.Output -join "`n") -match 'Core 0\.1\.0 -> 0\.1\.1') 'default Core patch was not reported'
  Assert-True (($patchResult.Output -join "`n") -match 'CLI 0\.2\.0 -> 0\.2\.1') 'default CLI patch was not reported'
  Assert-Equal '0.1.0' (Read-Json (Join-Path $patchFixture.Repo 'packages\core\package.json')).version 'Core manifest was not restored'
  Assert-Equal '0.2.0' (Read-Json (Join-Path $patchFixture.Repo 'packages\cli\package.json')).version 'CLI manifest was not restored'
  $dryRunStatus = @(& git -C $patchFixture.Repo status --porcelain) -join "`n"
  Assert-Equal '' $dryRunStatus 'DryRun left tracked changes'
  $patchCommands = Get-LoggedCommands $patchFixture
  Assert-Command $patchCommands 'version patch -w packages/core --no-git-tag-version'
  Assert-Command $patchCommands 'version patch -w packages/cli --no-git-tag-version'
  Assert-Command $patchCommands 'pkg set dependencies.@argon-agent/core=^0.1.1 -w packages/cli'
  Assert-Command $patchCommands 'install --package-lock-only --ignore-scripts'
  Assert-Command $patchCommands 'install --include=dev --ignore-scripts'
  Assert-Command $patchCommands 'test'
  Assert-Command $patchCommands 'run build'
  Assert-Command $patchCommands 'run verify:dist -w packages/core'
  Assert-Command $patchCommands 'pack -w packages/core --dry-run --json'
  Assert-Command $patchCommands 'pack -w packages/cli --dry-run --json'
  Assert-True (-not ($patchCommands | Where-Object { $_ -like 'publish *' })) 'DryRun called npm publish'

  Write-Host '[release-test] minor dry-run'
  $minorFixture = New-ReleaseFixture
  $fixtures += $minorFixture
  $minorResult = Invoke-ReleaseFixture $minorFixture @('-DryRun', '-Bump', 'minor', '-NpmCommand', $fakeNpm)
  Assert-Equal 0 $minorResult.ExitCode ($minorResult.Output -join [Environment]::NewLine)
  Assert-True (($minorResult.Output -join "`n") -match 'Core 0\.1\.0 -> 0\.2\.0') 'Core minor was not reported'
  Assert-True (($minorResult.Output -join "`n") -match 'CLI 0\.2\.0 -> 0\.3\.0') 'CLI minor was not reported'
  Assert-Command (Get-LoggedCommands $minorFixture) 'pkg set dependencies.@argon-agent/core=^0.2.0 -w packages/cli'

  Write-Host '[release-test] resume after Core publish'
  $resumeFixture = New-ReleaseFixture -CoreVersion '0.1.1' -CliVersion '0.2.1' -CoreRange '^0.1.1' -PublishedCore @('0.1.1')
  $fixtures += $resumeFixture
  $resumeResult = Invoke-ReleaseFixture $resumeFixture @('-Resume', '-NpmCommand', $fakeNpm)
  Assert-Equal 0 $resumeResult.ExitCode ($resumeResult.Output -join [Environment]::NewLine)
  $resumeCommands = Get-LoggedCommands $resumeFixture
  Assert-True (-not ($resumeCommands | Where-Object { $_ -like 'version *' })) 'Resume bumped a version'
  Assert-True (-not ($resumeCommands -contains 'publish -w packages/core --access public --registry https://registry.npmjs.org/')) 'Resume republished Core'
  Assert-Command $resumeCommands 'publish -w packages/cli --access public --registry https://registry.npmjs.org/'
  $resumeState = Read-Json $resumeFixture.State
  Assert-True (@($resumeState.core) -contains '0.1.1') 'Core state changed during resume'
  Assert-True (@($resumeState.cli) -contains '0.2.1') 'CLI was not published during resume'
  # The published-metadata check must accept npm's normalized 'dist/cli.js' and tolerate
  # notices on stderr; both used to fail after a successful publish, which made -Resume
  # unable to ever converge.
  Assert-Command $resumeCommands "view @argon-agent/cli@0.2.1 version bin --json --registry https://registry.npmjs.org/"

  Write-Host '[release-test] unauthenticated registry'
  $authFixture = New-ReleaseFixture
  $fixtures += $authFixture
  $authResult = Invoke-ReleaseFixture $authFixture @('-NpmCommand', $fakeNpm) -Unauthenticated
  Assert-True ($authResult.ExitCode -ne 0) 'unauthenticated release unexpectedly succeeded'
  $authText = ($authResult.Output | ForEach-Object { $_.ToString() }) -join "`n"
  Assert-True ($authText -match 'npm login') 'auth failure did not point at npm login'
  $authCommands = Get-LoggedCommands $authFixture
  Assert-True (-not ($authCommands | Where-Object { $_ -like 'publish *' })) 'unauthenticated run reached npm publish'
  Assert-Equal '0.1.0' (Read-Json (Join-Path $authFixture.Repo 'packages\core\package.json')).version 'Core manifest was not restored after auth failure'
  Assert-Equal '0.2.0' (Read-Json (Join-Path $authFixture.Repo 'packages\cli\package.json')).version 'CLI manifest was not restored after auth failure'

  Write-Host '[release-test] PASS (4 scenarios)'
} finally {
  foreach ($fixture in $fixtures) {
    if ($fixture -and (Test-Path -LiteralPath $fixture.Base)) {
      Remove-Item -LiteralPath $fixture.Base -Recurse -Force
    }
  }
}
