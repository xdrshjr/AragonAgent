$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$releaseScript = Join-Path $projectRoot 'publish-latest.ps1'
$fakeNpm = Join-Path $PSScriptRoot 'fake-npm.ps1'
$warningPreload = Join-Path $projectRoot 'packages\cli\runtime\insecure-tls-warning.cjs'
$insecureTlsWarning = "Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' makes TLS connections and HTTPS requests insecure by disabling certificate verification."

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
  $base = Join-Path ([IO.Path]::GetTempPath()) ("aragon release test " + [guid]::NewGuid().ToString('N'))
  $repo = Join-Path $base 'repo'
  New-Item -ItemType Directory -Force -Path (Join-Path $repo 'packages\core') | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $repo 'packages\cli') | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $repo 'packages\cli\runtime') | Out-Null

  Write-Json (Join-Path $repo 'package.json') ([ordered]@{
    name = 'release-fixture'
    private = $true
    workspaces = @('packages/*')
  })
  Write-Json (Join-Path $repo 'packages\core\package.json') ([ordered]@{
    name = '@aragon-agent/core'
    version = $CoreVersion
  })
  Write-Json (Join-Path $repo 'packages\cli\package.json') ([ordered]@{
    name = '@aragon-agent/cli'
    version = $CliVersion
    bin = [ordered]@{ aragon = './dist/launcher.js' }
    dependencies = [ordered]@{ '@aragon-agent/core' = $CoreRange }
  })
  Write-Json (Join-Path $repo 'package-lock.json') ([ordered]@{
    name = 'release-fixture'
    lockfileVersion = 3
    packages = [ordered]@{
      'packages/core' = [ordered]@{ name = '@aragon-agent/core'; version = $CoreVersion }
      'packages/cli' = [ordered]@{
        name = '@aragon-agent/cli'
        version = $CliVersion
        bin = [ordered]@{ aragon = 'dist/launcher.js' }
        dependencies = [ordered]@{ '@aragon-agent/core' = $CoreRange }
      }
    }
  })
  '.worktrees/', 'dist/' | Set-Content -LiteralPath (Join-Path $repo '.gitignore') -Encoding ascii
  Copy-Item -LiteralPath $releaseScript -Destination (Join-Path $repo 'publish-latest.ps1')
  Copy-Item -LiteralPath $warningPreload -Destination (Join-Path $repo 'packages\cli\runtime\insecure-tls-warning.cjs')

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

function Invoke-ReleaseFixture(
  $Fixture,
  [string[]]$Arguments,
  [switch]$Unauthenticated,
  [switch]$ScopeMissing,
  [switch]$OmitCliRuntime
) {
  $previousLog = $env:ARAGON_FAKE_NPM_LOG
  $previousState = $env:ARAGON_FAKE_NPM_STATE
  $previousUnauthenticated = $env:ARAGON_FAKE_NPM_UNAUTHENTICATED
  $previousScopeMissing = $env:ARAGON_FAKE_NPM_SCOPE_MISSING
  $previousOmitCliRuntime = $env:ARAGON_FAKE_NPM_OMIT_CLI_RUNTIME
  try {
    $env:ARAGON_FAKE_NPM_LOG = $Fixture.Log
    $env:ARAGON_FAKE_NPM_STATE = $Fixture.State
    $env:ARAGON_FAKE_NPM_UNAUTHENTICATED = if ($Unauthenticated) { '1' } else { $null }
    $env:ARAGON_FAKE_NPM_SCOPE_MISSING = if ($ScopeMissing) { '1' } else { $null }
    $env:ARAGON_FAKE_NPM_OMIT_CLI_RUNTIME = if ($OmitCliRuntime) { '1' } else { $null }
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Fixture.Repo 'publish-latest.ps1') @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousErrorActionPreference
    return [pscustomobject]@{ ExitCode = $exitCode; Output = @($output) }
  } finally {
    $ErrorActionPreference = 'Stop'
    $env:ARAGON_FAKE_NPM_LOG = $previousLog
    $env:ARAGON_FAKE_NPM_STATE = $previousState
    $env:ARAGON_FAKE_NPM_UNAUTHENTICATED = $previousUnauthenticated
    $env:ARAGON_FAKE_NPM_SCOPE_MISSING = $previousScopeMissing
    $env:ARAGON_FAKE_NPM_OMIT_CLI_RUNTIME = $previousOmitCliRuntime
  }
}

function Invoke-ReleaseFixtureInProcess(
  $Fixture,
  [ValidateSet('resume', 'dry-run', 'empty', 'restore-failure', 'unauthenticated', 'otp')]
  [string]$Scenario,
  [string]$InitialNodeOptions = '__unused_for_absent_scenario__'
) {
  $helperScript = Join-Path $Fixture.Base 'call-release.ps1'
  @'
param(
  [string]$ReleaseScript,
  [string]$NpmCommand,
  [string]$Scenario
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$env:NODE_TLS_REJECT_UNAUTHORIZED = '0'
if ($Scenario -eq 'empty' -or $Scenario -eq 'restore-failure') {
  # Preserve the present-but-empty entry inherited from ProcessStartInfo.
} elseif ($Scenario -eq 'dry-run') {
  Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
} else {
  $env:NODE_OPTIONS = $env:ARAGON_INITIAL_NODE_OPTIONS
}
$env:ARAGON_FAKE_NPM_UNAUTHENTICATED = if ($Scenario -eq 'unauthenticated') { '1' } else { $null }
$env:ARAGON_FAKE_NPM_REQUIRED_OTP = if ($Scenario -eq 'otp') { '123456' } else { $null }
$env:ARAGON_FAKE_OTP_PROMPTS = '0'
if ($Scenario -eq 'otp') {
  function Read-Host {
    param([string]$Prompt, [switch]$AsSecureString)
    if (-not $AsSecureString) { throw 'OTP prompt did not mask its input' }
    $env:ARAGON_FAKE_OTP_PROMPTS = ([int]$env:ARAGON_FAKE_OTP_PROMPTS + 1).ToString()
    return ConvertTo-SecureString '123456' -AsPlainText -Force
  }
}
$threw = $false
$errorText = ''
if ($Scenario -eq 'restore-failure') {
  function Add-Type { throw 'forced Add-Type failure during NODE_OPTIONS restoration' }
}
try {
  $releaseOutput = @(switch ($Scenario) {
    'resume' { & $ReleaseScript -Resume -NpmCommand $NpmCommand 2>&1 }
    'dry-run' { & $ReleaseScript -DryRun -NpmCommand $NpmCommand 2>&1 }
    'empty' { & $ReleaseScript -DryRun -NpmCommand $NpmCommand 2>&1 }
    'restore-failure' { & $ReleaseScript -DryRun -NpmCommand $NpmCommand 2>&1 }
    'unauthenticated' { & $ReleaseScript -NpmCommand $NpmCommand 2>&1 }
    'otp' { & $ReleaseScript -Resume -PromptForOtp -NpmCommand $NpmCommand 2>&1 }
  })
} catch {
  $threw = $true
  $errorText = $_.Exception.Message
}

$childObservation = [pscustomobject]@{ present = $null; value = $null }
if ($Scenario -eq 'empty') {
  $nodeObservation = @(
    & node -e "process.stdout.write(JSON.stringify({ present: Object.hasOwn(process.env, 'NODE_OPTIONS'), value: process.env.NODE_OPTIONS ?? null }));"
  )
  $childObservation = ($nodeObservation | Select-Object -Last 1) | ConvertFrom-Json
}

[ordered]@{
  threw = $threw
  error = $errorText
  nodeOptionsPresent = Test-Path Env:NODE_OPTIONS
  nodeOptions = $env:NODE_OPTIONS
  childNodeOptionsPresent = $childObservation.present
  childNodeOptions = $childObservation.value
  currentLocation = (Get-Location).Path
  otpPrompts = [int]$env:ARAGON_FAKE_OTP_PROMPTS
} | ConvertTo-Json -Compress
'@ | Set-Content -LiteralPath $helperScript -Encoding utf8

  $previousLog = $env:ARAGON_FAKE_NPM_LOG
  $previousState = $env:ARAGON_FAKE_NPM_STATE
  $previousUnauthenticated = $env:ARAGON_FAKE_NPM_UNAUTHENTICATED
  $previousInitialNodeOptions = $env:ARAGON_INITIAL_NODE_OPTIONS
  try {
    $env:ARAGON_FAKE_NPM_LOG = $Fixture.Log
    $env:ARAGON_FAKE_NPM_STATE = $Fixture.State
    $env:ARAGON_FAKE_NPM_UNAUTHENTICATED = $null
    $env:ARAGON_INITIAL_NODE_OPTIONS = $InitialNodeOptions
    $previousErrorActionPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      if ($Scenario -eq 'empty' -or $Scenario -eq 'restore-failure') {
        $escapedHelper = $helperScript.Replace("'", "''")
        $escapedRelease = (Join-Path $Fixture.Repo 'publish-latest.ps1').Replace("'", "''")
        $escapedNpm = $fakeNpm.Replace("'", "''")
        $helperCommand = "& '$escapedHelper' -ReleaseScript '$escapedRelease' -NpmCommand '$escapedNpm' -Scenario $Scenario"
        $encodedCommand = [Convert]::ToBase64String(
          [Text.Encoding]::Unicode.GetBytes($helperCommand)
        )
        $startInfo = New-Object Diagnostics.ProcessStartInfo
        $startInfo.FileName = (Get-Process -Id $PID).Path
        $startInfo.Arguments = "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encodedCommand"
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.EnvironmentVariables['NODE_OPTIONS'] = ''
        $child = [Diagnostics.Process]::Start($startInfo)
        $stdoutTask = $child.StandardOutput.ReadToEndAsync()
        $stderrTask = $child.StandardError.ReadToEndAsync()
        $child.WaitForExit()
        $exitCode = $child.ExitCode
        $combinedOutput = $stdoutTask.Result + [Environment]::NewLine + $stderrTask.Result
        $output = @($combinedOutput -split '\r?\n' | Where-Object { $_.Length -gt 0 })
        $child.Dispose()
      } else {
        $output = @(
          & powershell -NoProfile -ExecutionPolicy Bypass -File $helperScript `
            -ReleaseScript (Join-Path $Fixture.Repo 'publish-latest.ps1') `
            -NpmCommand $fakeNpm `
            -Scenario $Scenario 2>&1
        )
        $exitCode = $LASTEXITCODE
      }
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    $jsonLines = @($output | Where-Object { $_.ToString().Trim().StartsWith('{') })
    $record = if ($jsonLines.Count -gt 0) {
      $jsonLines[-1].ToString() | ConvertFrom-Json
    } else {
      $null
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = $output; Record = $record }
  } finally {
    $env:ARAGON_FAKE_NPM_LOG = $previousLog
    $env:ARAGON_FAKE_NPM_STATE = $previousState
    $env:ARAGON_FAKE_NPM_UNAUTHENTICATED = $previousUnauthenticated
    $env:ARAGON_INITIAL_NODE_OPTIONS = $previousInitialNodeOptions
  }
}

function Get-LoggedRecords($Fixture) {
  return @(
    Get-Content -LiteralPath $Fixture.Log -Encoding utf8 |
      Where-Object { $_.Trim().Length -gt 0 } |
      ForEach-Object { ConvertFrom-Json $_ }
  )
}

function Get-LoggedCommands($Fixture) {
  return @(
    Get-LoggedRecords $Fixture | ForEach-Object { $_.args -join ' ' }
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
  Assert-Command $patchCommands 'version patch -w packages/core --no-git-tag-version --no-workspaces-update'
  Assert-Command $patchCommands 'version patch -w packages/cli --no-git-tag-version --no-workspaces-update'
  Assert-Command $patchCommands 'pkg set dependencies.@aragon-agent/core=^0.1.1 -w packages/cli'
  Assert-Command $patchCommands 'install --package-lock-only --ignore-scripts'
  Assert-Command $patchCommands 'install --include=dev --ignore-scripts'
  Assert-Command $patchCommands 'test'
  Assert-Command $patchCommands 'run build'
  Assert-True ([array]::IndexOf($patchCommands, 'run build') -lt [array]::IndexOf($patchCommands, 'test')) 'release must build before tests inspect dist'
  Assert-Command $patchCommands 'run verify:dist -w packages/core'
  # The brand gate is the machine form of "no legacy brand ships"; asserting it in
  # both dry-run scenarios is what stops it from being quietly lifted back out of
  # the release path.
  Assert-Command $patchCommands 'run verify:brand'
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
  $minorCommands = Get-LoggedCommands $minorFixture
  Assert-Command $minorCommands 'pkg set dependencies.@aragon-agent/core=^0.2.0 -w packages/cli'
  Assert-Command $minorCommands 'run verify:brand'

  Write-Host '[release-test] CLI pack must contain the warning preload'
  $missingRuntimeFixture = New-ReleaseFixture
  $fixtures += $missingRuntimeFixture
  $missingRuntimeResult = Invoke-ReleaseFixture `
    $missingRuntimeFixture `
    @('-DryRun', '-NpmCommand', $fakeNpm) `
    -OmitCliRuntime
  Assert-True ($missingRuntimeResult.ExitCode -ne 0) 'release accepted a CLI pack without its warning preload'
  $missingRuntimeText = ($missingRuntimeResult.Output | ForEach-Object { $_.ToString() }) -join "`n"
  Assert-True ($missingRuntimeText.Contains('runtime/insecure-tls-warning.cjs')) 'pack failure did not name the missing warning preload'

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
  # The published-metadata check must accept npm's normalized 'dist/launcher.js'
  # and tolerate notices on stderr; both used to fail after a successful publish,
  # which made -Resume unable to ever converge.
  Assert-Command $resumeCommands "view @aragon-agent/cli@0.2.1 version bin --json --registry https://registry.npmjs.org/"
  Assert-Command $resumeCommands 'access list packages @aragon-agent --registry https://registry.npmjs.org/'
  # Negative half of the scope check: an owned scope must produce no warning at
  # all. Without this the next scenario could pass against a function that warns
  # unconditionally.
  Assert-True (-not (($resumeResult.Output | ForEach-Object { $_.ToString() }) -join "`n" -match 'Unable to confirm ownership')) 'owned scope produced a scope warning'

  Write-Host '[release-test] insecure TLS resume preloads Node children'
  $tlsFixture = New-ReleaseFixture -CoreVersion '0.1.1' -CliVersion '0.2.1' -CoreRange '^0.1.1' -PublishedCore @('0.1.1')
  $fixtures += $tlsFixture
  $tlsWasPresent = Test-Path Env:NODE_TLS_REJECT_UNAUTHORIZED
  $previousTls = if ($tlsWasPresent) { $env:NODE_TLS_REJECT_UNAUTHORIZED } else { $null }
  $nodeOptionsWasPresent = Test-Path Env:NODE_OPTIONS
  $previousNodeOptions = if ($nodeOptionsWasPresent) { $env:NODE_OPTIONS } else { $null }
  try {
    $env:NODE_TLS_REJECT_UNAUTHORIZED = '0'
    $env:NODE_OPTIONS = '--trace-warnings'
    $tlsResult = Invoke-ReleaseFixture $tlsFixture @('-Resume', '-NpmCommand', $fakeNpm)
    Assert-Equal 0 $tlsResult.ExitCode ($tlsResult.Output -join [Environment]::NewLine)

    $tlsRecords = Get-LoggedRecords $tlsFixture
    Assert-True ($tlsRecords.Count -gt 0) 'insecure TLS release did not call fake npm'
    $canonicalPreload = (Resolve-Path (Join-Path $tlsFixture.Repo 'packages\cli\runtime\insecure-tls-warning.cjs')).Path.Replace('\', '/')
    $expectedPreloadOption = "--require `"$canonicalPreload`""
    foreach ($record in $tlsRecords) {
      $nodeOptions = [string]$record.nodeOptions
      Assert-True ($nodeOptions.Contains('--trace-warnings')) 'existing NODE_OPTIONS were not preserved'
      Assert-True ($nodeOptions.Contains($expectedPreloadOption)) "preload option was not quoted and canonical: $nodeOptions"
      Assert-Equal 1 ([regex]::Matches($nodeOptions, 'insecure-tls-warning\.cjs', 'IgnoreCase').Count) 'preload was not present exactly once'
    }
    Assert-True ($canonicalPreload.Contains('aragon release test ')) 'release fixture path did not contain a literal space'

    $env:NODE_OPTIONS = [string]$tlsRecords[0].nodeOptions
    $nodeOutput = @(& node (Join-Path $tlsFixture.Repo 'packages\cli\dist\cli.js') --version 2>&1)
    Assert-Equal 0 $LASTEXITCODE ($nodeOutput -join [Environment]::NewLine)

    $tlsText = ($tlsResult.Output | ForEach-Object { $_.ToString() }) -join "`n"
    Assert-True (-not $tlsText.Contains('Remove it before publishing')) 'former hard block was printed'
    Assert-True (-not $tlsText.Contains($insecureTlsWarning)) 'standard insecure TLS warning was printed'
    $releaseSource = Get-Content -Raw -LiteralPath $releaseScript -Encoding utf8
    Assert-True (-not $releaseSource.Contains('Remove it before publishing')) 'former hard block remains in publish-latest.ps1'
  } finally {
    if ($tlsWasPresent) { $env:NODE_TLS_REJECT_UNAUTHORIZED = $previousTls } else { Remove-Item Env:NODE_TLS_REJECT_UNAUTHORIZED -ErrorAction SilentlyContinue }
    if ($nodeOptionsWasPresent) { $env:NODE_OPTIONS = $previousNodeOptions } else { Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue }
  }

  Write-Host '[release-test] scope missing warns but does not block'
  $scopeFixture = New-ReleaseFixture -CoreVersion '0.1.1' -CliVersion '0.2.1' -CoreRange '^0.1.1' -PublishedCore @('0.1.1')
  $fixtures += $scopeFixture
  $scopeResult = Invoke-ReleaseFixture $scopeFixture @('-Resume', '-NpmCommand', $fakeNpm) -ScopeMissing
  # Warning, not error: a brand-new empty org and a read-restricted CI token both
  # fail this probe, and neither is a reason to block a legitimate release.
  Assert-Equal 0 $scopeResult.ExitCode ($scopeResult.Output -join [Environment]::NewLine)
  $scopeText = ($scopeResult.Output | ForEach-Object { $_.ToString() }) -join "`n"
  Assert-True ($scopeText -match 'Unable to confirm ownership') 'missing scope did not warn'
  $scopeCommands = Get-LoggedCommands $scopeFixture
  Assert-Command $scopeCommands 'access list packages @aragon-agent --registry https://registry.npmjs.org/'
  Assert-Command $scopeCommands 'publish -w packages/cli --access public --registry https://registry.npmjs.org/'

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

  Write-Host '[release-test] OTP-protected publish'
  $otpFixture = New-ReleaseFixture `
    -CoreVersion '0.1.1' `
    -CliVersion '0.2.1' `
    -CoreRange '^0.1.1' `
    -PublishedCore @('0.1.1')
  $fixtures += $otpFixture
  $otpValue = '123456'
  $otpCall = Invoke-ReleaseFixtureInProcess $otpFixture 'otp'
  Assert-Equal 0 $otpCall.ExitCode ($otpCall.Output -join [Environment]::NewLine)
  Assert-True ($null -ne $otpCall.Record) 'OTP helper did not return control to its caller'
  Assert-True (-not $otpCall.Record.threw) $otpCall.Record.error
  Assert-Equal `
    1 `
    $otpCall.Record.otpPrompts `
    'partial resume did not prompt exactly once before CLI publish'
  $otpText = ($otpCall.Output | ForEach-Object { $_.ToString() }) -join "`n"
  Assert-True (-not $otpText.Contains($otpValue)) 'OTP was printed in release output'
  $otpRecords = Get-LoggedRecords $otpFixture
  $publishRecords = @($otpRecords | Where-Object { $_.args[0] -eq 'publish' })
  Assert-Equal 1 $publishRecords.Count 'partial OTP resume did not publish exactly one package'
  Assert-True `
    (($publishRecords[0].args -join ' ') -match 'packages/cli') `
    'partial OTP resume did not publish CLI'
  foreach ($record in $publishRecords) {
    Assert-True $record.otpPresent 'npm publish child did not receive OTP configuration'
    Assert-True `
      (-not (($record.args -join ' ').Contains($otpValue))) `
      'OTP was passed on the npm command line'
  }
  foreach ($record in @($otpRecords | Where-Object { $_.args[0] -ne 'publish' })) {
    Assert-True (-not $record.otpPresent) 'OTP leaked into a non-publish npm command'
  }

  Write-Host '[release-test] same-process NODE_OPTIONS restoration'
  $successFixture = New-ReleaseFixture -CoreVersion '0.1.1' -CliVersion '0.2.1' -CoreRange '^0.1.1' -PublishedCore @('0.1.1')
  $fixtures += $successFixture
  $successPreload = (Resolve-Path (Join-Path $successFixture.Repo 'packages\cli\runtime\insecure-tls-warning.cjs')).Path.Replace('\', '/')
  $successInitialNodeOptions = '--trace-warnings'
  $successExpectedPreload = "--require `"$successPreload`""
  $successCall = Invoke-ReleaseFixtureInProcess $successFixture 'resume' $successInitialNodeOptions
  Assert-Equal 0 $successCall.ExitCode ($successCall.Output -join [Environment]::NewLine)
  Assert-True ($null -ne $successCall.Record) 'same-process success helper did not return control to its caller'
  Assert-True (-not $successCall.Record.threw) $successCall.Record.error
  Assert-True $successCall.Record.nodeOptionsPresent 'successful release removed the caller NODE_OPTIONS'
  Assert-Equal $successInitialNodeOptions $successCall.Record.nodeOptions 'successful release did not preserve exact NODE_OPTIONS'
  foreach ($record in (Get-LoggedRecords $successFixture)) {
    $successChildOptions = [string]$record.nodeOptions
    Assert-True ($successChildOptions.Contains($successInitialNodeOptions)) 'success child lost the caller NODE_OPTIONS'
    Assert-True ($successChildOptions.Contains($successExpectedPreload)) 'success child did not inherit the warning preload'
    Assert-Equal 1 ([regex]::Matches($successChildOptions, 'insecure-tls-warning\.cjs', 'IgnoreCase').Count) 'success child did not inherit exactly one warning preload'
  }

  $dedupeFixture = New-ReleaseFixture -CoreVersion '0.1.1' -CliVersion '0.2.1' -CoreRange '^0.1.1' -PublishedCore @('0.1.1')
  $fixtures += $dedupeFixture
  $dedupePreload = (Resolve-Path (Join-Path $dedupeFixture.Repo 'packages\cli\runtime\insecure-tls-warning.cjs')).Path.Replace('\', '/')
  $dedupeInitialNodeOptions = "--trace-warnings --require `"$dedupePreload`""
  $dedupeCall = Invoke-ReleaseFixtureInProcess $dedupeFixture 'resume' $dedupeInitialNodeOptions
  Assert-Equal 0 $dedupeCall.ExitCode ($dedupeCall.Output -join [Environment]::NewLine)
  Assert-True ($null -ne $dedupeCall.Record) 'same-process dedupe helper did not return control to its caller'
  Assert-True (-not $dedupeCall.Record.threw) $dedupeCall.Record.error
  Assert-Equal $dedupeInitialNodeOptions $dedupeCall.Record.nodeOptions 'existing preload option was rewritten'
  foreach ($record in (Get-LoggedRecords $dedupeFixture)) {
    Assert-Equal $dedupeInitialNodeOptions ([string]$record.nodeOptions) 'existing preload option was duplicated or rewritten'
  }

  $dryRunFixture = New-ReleaseFixture
  $fixtures += $dryRunFixture
  $dryRunCall = Invoke-ReleaseFixtureInProcess $dryRunFixture 'dry-run'
  Assert-Equal 0 $dryRunCall.ExitCode ($dryRunCall.Output -join [Environment]::NewLine)
  Assert-True ($null -ne $dryRunCall.Record) 'dry-run terminated its calling PowerShell process'
  Assert-True (-not $dryRunCall.Record.threw) $dryRunCall.Record.error
  Assert-True (-not $dryRunCall.Record.nodeOptionsPresent) 'dry-run left NODE_OPTIONS present'

  $emptyFixture = New-ReleaseFixture
  $fixtures += $emptyFixture
  $emptyCall = Invoke-ReleaseFixtureInProcess $emptyFixture 'empty'
  Assert-Equal 0 $emptyCall.ExitCode ($emptyCall.Output -join [Environment]::NewLine)
  Assert-True ($null -ne $emptyCall.Record) 'present-empty helper did not return a lifecycle record'
  Assert-True (-not $emptyCall.Record.threw) $emptyCall.Record.error
  Assert-True $emptyCall.Record.childNodeOptionsPresent 'future child did not inherit empty NODE_OPTIONS'
  Assert-Equal '' $emptyCall.Record.childNodeOptions 'future child inherited a changed NODE_OPTIONS'

  $restoreFailureFixture = New-ReleaseFixture
  $fixtures += $restoreFailureFixture
  $restoreFailureCall = Invoke-ReleaseFixtureInProcess $restoreFailureFixture 'restore-failure'
  Assert-Equal 0 $restoreFailureCall.ExitCode ($restoreFailureCall.Output -join [Environment]::NewLine)
  Assert-True ($null -ne $restoreFailureCall.Record) 'restore-failure helper did not return a lifecycle record'
  Assert-True $restoreFailureCall.Record.threw 'forced NODE_OPTIONS restore failure did not throw'
  Assert-Equal $projectRoot $restoreFailureCall.Record.currentLocation 'restore failure leaked the release working directory'

  $failureFixture = New-ReleaseFixture
  $fixtures += $failureFixture
  $failurePreload = (Resolve-Path (Join-Path $failureFixture.Repo 'packages\cli\runtime\insecure-tls-warning.cjs')).Path.Replace('\', '/')
  $failureInitialNodeOptions = "--redirect-warnings=`"$failurePreload.log`""
  $failureExpectedPreload = "--require `"$failurePreload`""
  $failureCall = Invoke-ReleaseFixtureInProcess $failureFixture 'unauthenticated' $failureInitialNodeOptions
  Assert-Equal 0 $failureCall.ExitCode ($failureCall.Output -join [Environment]::NewLine)
  Assert-True ($null -ne $failureCall.Record) 'failure helper did not return a lifecycle record'
  Assert-True $failureCall.Record.threw 'unauthenticated same-process release did not throw'
  Assert-True $failureCall.Record.nodeOptionsPresent 'failed release removed the caller NODE_OPTIONS'
  Assert-Equal $failureInitialNodeOptions $failureCall.Record.nodeOptions 'failed release did not restore exact NODE_OPTIONS'
  foreach ($record in (Get-LoggedRecords $failureFixture)) {
    $failureChildOptions = [string]$record.nodeOptions
    Assert-True ($failureChildOptions.Contains($failureExpectedPreload)) 'path substring prevented the exact preload option from being appended'
    Assert-Equal 1 ([regex]::Matches($failureChildOptions, '--require\s+"[^"]*insecure-tls-warning\.cjs"', 'IgnoreCase').Count) 'child did not inherit exactly one require preload'
  }

  Write-Host '[release-test] PASS (14 scenarios)'
} finally {
  foreach ($fixture in $fixtures) {
    if ($fixture -and (Test-Path -LiteralPath $fixture.Base)) {
      $resolvedBase = (Resolve-Path -LiteralPath $fixture.Base).Path
      $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
      Assert-True ($resolvedBase.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolvedBase) -match '^aragon release test [0-9a-f]{32}$') 'refusing to remove a path outside the release fixtures'
      Remove-Item -LiteralPath $fixture.Base -Recurse -Force
    }
  }
}
