[CmdletBinding()]
param(
  [ValidateSet('patch', 'minor', 'major')]
  [string]$Bump = 'patch',

  [switch]$DryRun,

  [switch]$Resume,

  [Parameter(DontShow = $true)]
  [string]$NpmCommand = 'npm',

  [Parameter(DontShow = $true)]
  [ValidateRange(1, 60)]
  [int]$RegistryRetries = 10,

  [Parameter(DontShow = $true)]
  [ValidateRange(0, 30)]
  [int]$RegistryRetrySeconds = 2
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$registry = 'https://registry.npmjs.org/'
$coreManifestPath = 'packages/core/package.json'
$cliManifestPath = 'packages/cli/package.json'
$lockfilePath = 'package-lock.json'
$versionFiles = @($coreManifestPath, $cliManifestPath, $lockfilePath)
$publishMayHaveStarted = $false
$snapshots = @{}
$npmExecutable = $NpmCommand
$npmPrefixArguments = @()

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

function Invoke-GitCapture {
  param([string[]]$Arguments)

  $output = @(& git @Arguments 2>&1)
  return [pscustomobject]@{
    ExitCode = $LASTEXITCODE
    Output = $output
    Text = ($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
  }
}

function Read-JsonFile([string]$Path) {
  return Get-Content -Raw -LiteralPath $Path -Encoding utf8 | ConvertFrom-Json
}

function Read-LockfileMetadata {
  $extractScript = @'
const fs = require('node:fs');
const path = process.argv[1];
const text = fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
const lock = JSON.parse(text);
const core = lock.packages && lock.packages['packages/core'];
const cli = lock.packages && lock.packages['packages/cli'];
process.stdout.write(JSON.stringify({
  coreVersion: core && core.version,
  cliVersion: cli && cli.version,
  cliCoreRange: cli && cli.dependencies && cli.dependencies['@argon-agent/core'],
  cliBin: cli && cli.bin
}));
'@
  $output = @(& node '-e' $extractScript $lockfilePath 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to read package-lock.json: $($output -join [Environment]::NewLine)"
  }
  return ($output -join [Environment]::NewLine) | ConvertFrom-Json
}

function Save-VersionFileSnapshots {
  foreach ($path in $versionFiles) {
    $resolvedPath = (Resolve-Path -LiteralPath $path).Path
    $snapshots[$resolvedPath] = [IO.File]::ReadAllBytes($resolvedPath)
  }
}

function Restore-VersionFileSnapshots {
  foreach ($entry in $snapshots.GetEnumerator()) {
    [IO.File]::WriteAllBytes([string]$entry.Key, [byte[]]$entry.Value)
  }
}

function Test-AllowedResumePath([string]$Path) {
  $normalized = $Path.Trim('"').Replace('\', '/')
  foreach ($allowed in $versionFiles) {
    if ($normalized -eq $allowed -or $normalized.EndsWith("/$allowed")) {
      return $true
    }
  }
  return $false
}

function Assert-RepositoryState {
  $status = Invoke-GitCapture @('status', '--porcelain', '--untracked-files=all', '--', '.')
  if ($status.ExitCode -ne 0) {
    throw "Unable to inspect Git state: $($status.Text)"
  }

  $lines = @($status.Output | ForEach-Object { $_.ToString() } | Where-Object { $_.Length -gt 0 })
  if (-not $Resume) {
    if ($lines.Count -gt 0) {
      throw "argon-agent-core must be clean before release. Commit or stash these files first:`n$($lines -join [Environment]::NewLine)"
    }
    return
  }

  $unexpected = @()
  foreach ($line in $lines) {
    if ($line.Length -lt 4 -or -not (Test-AllowedResumePath $line.Substring(3))) {
      $unexpected += $line
    }
  }
  if ($unexpected.Count -gt 0) {
    throw "-Resume only permits pending release-version files. Resolve these files first:`n$($unexpected -join [Environment]::NewLine)"
  }
}

function Test-NpmVersionExists([string]$PackageName, [string]$Version) {
  $specifier = "$PackageName@$Version"
  $result = Invoke-NpmCapture @('view', $specifier, 'version', '--registry', $registry)
  if ($result.ExitCode -eq 0) {
    return $true
  }
  if ($result.Text -match '(?i)E404|404\s+Not\s+Found|is not in this registry') {
    return $false
  }
  throw "Unable to query $specifier from npm:`n$($result.Text)"
}

function Wait-ForNpmVersion([string]$PackageName, [string]$Version) {
  for ($attempt = 1; $attempt -le $RegistryRetries; $attempt++) {
    if (Test-NpmVersionExists $PackageName $Version) {
      return
    }
    if ($attempt -lt $RegistryRetries -and $RegistryRetrySeconds -gt 0) {
      Write-Host "Waiting for $PackageName@$Version to become queryable ($attempt/$RegistryRetries)..."
      Start-Sleep -Seconds $RegistryRetrySeconds
    }
  }
  throw "$PackageName@$Version was published but is not queryable after $RegistryRetries attempts"
}

function Assert-PackageState {
  $core = Read-JsonFile $coreManifestPath
  $cli = Read-JsonFile $cliManifestPath
  $lockMetadata = Read-LockfileMetadata

  if (-not $lockMetadata.coreVersion -or -not $lockMetadata.cliVersion) {
    throw 'package-lock.json is missing Core or CLI workspace metadata'
  }
  if ($core.version -ne $lockMetadata.coreVersion) {
    throw "Core manifest/lock mismatch: $($core.version) != $($lockMetadata.coreVersion)"
  }
  if ($cli.version -ne $lockMetadata.cliVersion) {
    throw "CLI manifest/lock mismatch: $($cli.version) != $($lockMetadata.cliVersion)"
  }
  if ($core.version -match '-' -or $cli.version -match '-') {
    throw 'Pre-release versions are not supported by publish-latest.ps1; use the manual tagged workflow'
  }

  $expectedCoreRange = "^$($core.version)"
  $cliCoreRange = $cli.dependencies.'@argon-agent/core'
  $lockCoreRange = $lockMetadata.cliCoreRange
  if ($cliCoreRange -ne $expectedCoreRange -or $lockCoreRange -ne $expectedCoreRange) {
    throw "CLI must depend on $expectedCoreRange in both package.json and package-lock.json"
  }

  $binProperties = @($cli.bin.PSObject.Properties)
  if ($binProperties.Count -ne 1 -or $binProperties[0].Name -ne 'aragon' -or $binProperties[0].Value -ne './dist/cli.js') {
    throw 'CLI package must expose only bin.aragon = ./dist/cli.js'
  }
  $lockBinProperties = @($lockMetadata.cliBin.PSObject.Properties)
  if ($lockBinProperties.Count -ne 1 -or $lockBinProperties[0].Name -ne 'aragon' -or $lockBinProperties[0].Value -ne 'dist/cli.js') {
    throw 'CLI lockfile metadata must expose only npm-normalized bin.aragon = dist/cli.js'
  }

  return [pscustomobject]@{
    CoreVersion = [string]$core.version
    CliVersion = [string]$cli.version
    CoreRange = [string]$cliCoreRange
  }
}

function Invoke-ReleaseChecks($PackageState) {
  Invoke-NpmCommand @('test')
  Invoke-NpmCommand @('run', 'build')
  Invoke-NpmCommand @('run', 'verify:dist', '-w', 'packages/core')
  Invoke-NpmCommand @('pack', '-w', 'packages/core', '--dry-run', '--json')
  Invoke-NpmCommand @('pack', '-w', 'packages/cli', '--dry-run', '--json')

  Write-Host '> node packages/cli/dist/cli.js --version' -ForegroundColor DarkGray
  $versionOutput = @(& node 'packages/cli/dist/cli.js' '--version' 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "CLI dist smoke failed ($LASTEXITCODE): $($versionOutput -join [Environment]::NewLine)"
  }
  $reportedVersion = ($versionOutput | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_.Length -gt 0 } | Select-Object -Last 1)
  if ($reportedVersion -ne $PackageState.CliVersion) {
    throw "CLI dist reports '$reportedVersion', expected '$($PackageState.CliVersion)'"
  }
}

function Assert-PublishedCliMetadata([string]$Version) {
  $result = Invoke-NpmCapture @('view', "@argon-agent/cli@$Version", 'version', 'bin', '--json', '--registry', $registry)
  if ($result.ExitCode -ne 0) {
    throw "Published CLI metadata is not queryable:`n$($result.Text)"
  }
  try {
    $metadata = $result.Text | ConvertFrom-Json
  } catch {
    throw "Published CLI metadata is not valid JSON:`n$($result.Text)"
  }
  if ($metadata.version -ne $Version -or $metadata.bin.aragon -ne './dist/cli.js') {
    throw "Published CLI metadata does not contain version $Version and bin.aragon"
  }
  if (@($metadata.bin.PSObject.Properties).Count -ne 1) {
    throw 'Published CLI metadata exposes an unexpected executable alias'
  }
}

if ($DryRun -and $Resume) {
  throw '-DryRun and -Resume cannot be used together'
}

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $coreManifestPath)) -or
    -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $cliManifestPath)) -or
    -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $lockfilePath))) {
  throw 'publish-latest.ps1 must run from an ArgonAgent source tree containing both workspaces and package-lock.json'
}

Push-Location $PSScriptRoot
try {
  Assert-RepositoryState
  Save-VersionFileSnapshots

  $oldCoreVersion = [string](Read-JsonFile $coreManifestPath).version
  $oldCliVersion = [string](Read-JsonFile $cliManifestPath).version

  if (-not $Resume) {
    Invoke-NpmCommand @('version', $Bump, '-w', 'packages/core', '--no-git-tag-version')
    $newCoreVersion = [string](Read-JsonFile $coreManifestPath).version
    Invoke-NpmCommand @('pkg', 'set', "dependencies.@argon-agent/core=^$newCoreVersion", '-w', 'packages/cli')
    Invoke-NpmCommand @('version', $Bump, '-w', 'packages/cli', '--no-git-tag-version')
    Invoke-NpmCommand @('install', '--package-lock-only', '--ignore-scripts')
    Invoke-NpmCommand @('install', '--include=dev', '--ignore-scripts')
  }

  $packageState = Assert-PackageState
  if ($Resume) {
    Write-Host "Resume versions: Core $($packageState.CoreVersion), CLI $($packageState.CliVersion)" -ForegroundColor Cyan
  } else {
    Write-Host "Version plan: Core $oldCoreVersion -> $($packageState.CoreVersion); CLI $oldCliVersion -> $($packageState.CliVersion)" -ForegroundColor Cyan
  }

  Invoke-ReleaseChecks $packageState

  if ($DryRun) {
    Restore-VersionFileSnapshots
    Write-Host 'Dry run completed; version files were restored and nothing was published.' -ForegroundColor Green
    exit 0
  }

  if ($NpmCommand -eq 'npm' -and $env:NODE_TLS_REJECT_UNAUTHORIZED -eq '0') {
    throw 'NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS verification. Remove it before publishing.'
  }

  Invoke-NpmCommand @('whoami', '--registry', $registry)
  $coreExists = Test-NpmVersionExists '@argon-agent/core' $packageState.CoreVersion
  $cliExists = Test-NpmVersionExists '@argon-agent/cli' $packageState.CliVersion

  if (-not $Resume -and ($coreExists -or $cliExists)) {
    $existing = @()
    if ($coreExists) { $existing += "@argon-agent/core@$($packageState.CoreVersion)" }
    if ($cliExists) { $existing += "@argon-agent/cli@$($packageState.CliVersion)" }
    throw "Refusing to overwrite published version(s): $($existing -join ', ')"
  }

  if (-not $coreExists) {
    $publishMayHaveStarted = $true
    Invoke-NpmCommand @('publish', '-w', 'packages/core', '--access', 'public', '--registry', $registry)
    Wait-ForNpmVersion '@argon-agent/core' $packageState.CoreVersion
  } else {
    Write-Host "Core $($packageState.CoreVersion) already exists; skipping it." -ForegroundColor Yellow
  }

  if (-not $cliExists) {
    $publishMayHaveStarted = $true
    Invoke-NpmCommand @('publish', '-w', 'packages/cli', '--access', 'public', '--registry', $registry)
    Wait-ForNpmVersion '@argon-agent/cli' $packageState.CliVersion
  } else {
    Write-Host "CLI $($packageState.CliVersion) already exists; skipping it." -ForegroundColor Yellow
  }

  Assert-PublishedCliMetadata $packageState.CliVersion
  Write-Host "Published @argon-agent/core@$($packageState.CoreVersion) and @argon-agent/cli@$($packageState.CliVersion)." -ForegroundColor Green
  Write-Host 'Commit package.json/package-lock.json and create the corresponding release tags.'
} catch {
  if (-not $Resume -and -not $publishMayHaveStarted -and $snapshots.Count -gt 0) {
    Restore-VersionFileSnapshots
    Write-Warning 'Release failed before npm publish; version files were restored.'
  } elseif ($publishMayHaveStarted) {
    Write-Warning 'npm publish may have started. Version files were preserved; inspect npm, then run .\publish-latest.ps1 -Resume.'
  }
  throw
} finally {
  Pop-Location
}
