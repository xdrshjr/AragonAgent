[CmdletBinding()]
param(
  [ValidateSet('patch', 'minor', 'major')]
  [string]$Bump = 'patch',

  [switch]$DryRun,

  [switch]$Resume,

  [Parameter(DontShow = $true)]
  [string]$NpmCommand = 'npm',

  [switch]$PromptForOtp,

  # The registry CDN has been observed serving a cached 404 for ~5 minutes after
  # the first-ever publish of a package name, so the default budget covers that
  # window rather than the ~18s that used to fail a perfectly good release.
  [Parameter(DontShow = $true)]
  [ValidateRange(1, 60)]
  [int]$RegistryRetries = 30,

  [Parameter(DontShow = $true)]
  [ValidateRange(0, 30)]
  [int]$RegistryRetrySeconds = 10
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$registry = 'https://registry.npmjs.org/'
$coreManifestPath = 'packages/core/package.json'
$cliManifestPath = 'packages/cli/package.json'
$lockfilePath = 'package-lock.json'
$cliBinName = 'aragon'
# npm strips the leading './' from bin paths when it accepts a publish, so the source
# manifest and the registry/lockfile metadata legitimately disagree on this one detail.
$cliBinSourcePath = './dist/launcher.js'
$cliBinNormalizedPath = 'dist/launcher.js'
$versionFiles = @($coreManifestPath, $cliManifestPath, $lockfilePath)
$publishMayHaveStarted = $false
$snapshots = @{}
$npmExecutable = $NpmCommand
$npmPrefixArguments = @()
$nodeOptionsWasPresent = Test-Path Env:NODE_OPTIONS
$originalNodeOptions = if ($nodeOptionsWasPresent) { $env:NODE_OPTIONS } else { $null }
$nodeOptionsChanged = $false
# The direct-registry probe below talks to the real npmjs.org. Gate it on the real
# npm so the fake-npm fixture stays hermetic and offline.
$registryProbeEnabled = ($NpmCommand -eq 'npm')

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

function Get-InsecureTlsWarningPreloadOption {
  $preloadPath = Join-Path $PSScriptRoot 'packages\cli\runtime\insecure-tls-warning.cjs'
  if (-not (Test-Path -LiteralPath $preloadPath)) {
    throw "Insecure TLS warning preload does not exist: $preloadPath"
  }

  $canonicalPreloadPath = [IO.Path]::GetFullPath($preloadPath).Replace('\', '/')
  $escapedPreloadPath = $canonicalPreloadPath.Replace('"', '\"')
  return "--require `"$escapedPreloadPath`""
}

function Enable-InsecureTlsWarningFilterForNodeChildren {
  if ($env:NODE_TLS_REJECT_UNAUTHORIZED -ne '0') {
    return
  }

  $preloadOption = Get-InsecureTlsWarningPreloadOption
  $normalizedNodeOptions = ([string]$env:NODE_OPTIONS).Replace('\', '/')
  $comparison = if ($env:OS -eq 'Windows_NT') {
    [StringComparison]::OrdinalIgnoreCase
  } else {
    [StringComparison]::Ordinal
  }
  $searchIndex = 0
  while ($searchIndex -lt $normalizedNodeOptions.Length) {
    $matchIndex = $normalizedNodeOptions.IndexOf($preloadOption, $searchIndex, $comparison)
    if ($matchIndex -lt 0) {
      break
    }
    $afterMatch = $matchIndex + $preloadOption.Length
    $hasStartBoundary = $matchIndex -eq 0 -or [char]::IsWhiteSpace(
      $normalizedNodeOptions[$matchIndex - 1]
    )
    $hasEndBoundary = $afterMatch -eq $normalizedNodeOptions.Length -or [char]::IsWhiteSpace(
      $normalizedNodeOptions[$afterMatch]
    )
    if ($hasStartBoundary -and $hasEndBoundary) {
      return
    }
    $searchIndex = $matchIndex + 1
  }

  $env:NODE_OPTIONS = if ([string]::IsNullOrEmpty($env:NODE_OPTIONS)) {
    $preloadOption
  } else {
    "$($env:NODE_OPTIONS) $preloadOption"
  }
  $script:nodeOptionsChanged = $true
}

function Restore-EmptyNodeOptionsForChildProcesses {
  if ($env:OS -ne 'Windows_NT') {
    $env:NODE_OPTIONS = ''
    return
  }

  if (-not ('AragonAgentNativeEnvironment' -as [type])) {
    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;

public static class AragonAgentNativeEnvironment {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool SetEnvironmentVariable(string name, string value);
}
'@ | Out-Null
  }

  if (-not [AragonAgentNativeEnvironment]::SetEnvironmentVariable('NODE_OPTIONS', '')) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "Failed to restore empty NODE_OPTIONS (Win32 error $errorCode)"
  }
}

function Restore-NodeOptions {
  if (-not $script:nodeOptionsChanged) {
    return
  }

  if ($script:nodeOptionsWasPresent) {
    if ([string]::IsNullOrEmpty($script:originalNodeOptions)) {
      Restore-EmptyNodeOptionsForChildProcesses
    } else {
      $env:NODE_OPTIONS = $script:originalNodeOptions
    }
  } else {
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
  }
  $script:nodeOptionsChanged = $false
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

# Set-StrictMode 2.0 turns a missing property into a terminating error, which would mask
# the descriptive assertion messages below with a raw PowerShell stack trace.
function Get-ObjectProperty($Object, [string]$Name) {
  if ($null -eq $Object) {
    return $null
  }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }
  return $property.Value
}

# A missing 'bin' object would otherwise surface as "The property 'Properties' cannot be
# found on this object" instead of the descriptive assertion below it.
# The unary comma keeps PowerShell from unrolling a single-property result into a scalar,
# which would make the .Count checks below fail under Set-StrictMode.
function Get-PropertyList($Object) {
  if ($null -eq $Object) {
    return ,@()
  }
  return ,@($Object.PSObject.Properties)
}

# Invoke-NpmCapture merges stderr into stdout so registry 404s stay matchable, which means
# any npm notice or Node warning lands in front of (or behind) a --json payload.
function ConvertFrom-NpmJsonText([string]$Text) {
  if ([string]::IsNullOrWhiteSpace($Text)) {
    return $null
  }
  $start = $Text.IndexOfAny([char[]]@('{', '['))
  $end = [Math]::Max($Text.LastIndexOf('}'), $Text.LastIndexOf(']'))
  if ($start -lt 0 -or $end -lt $start) {
    return $null
  }
  try {
    return $Text.Substring($start, $end - $start + 1) | ConvertFrom-Json
  } catch {
    return $null
  }
}

function ConvertTo-NormalizedBinPath([string]$Path) {
  return ($Path -replace '^\./', '')
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
  cliCoreRange: cli && cli.dependencies && cli.dependencies['@aragon-agent/core'],
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
      throw "aragon-agent-core must be clean before release. Commit or stash these files first:`n$($lines -join [Environment]::NewLine)"
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

function Get-RegistryVersionUrl([string]$PackageName, [string]$Version) {
  # Only the slash needs escaping; the registry serves '@scope%2fname' but rejects
  # a percent-encoded '@'.
  return "$registry$($PackageName.Replace('/', '%2F'))/$Version"
}

# `npm view` reads the whole package document, and npm's CDN caches 404s for that
# URL. This script's own pre-publish existence probe is what plants such a 404
# when a package name is being published for the FIRST time — so a completely
# successful publish keeps answering "not found" until the negative cache expires
# (~5 minutes, observed on @aragon-agent/cli@0.4.3). Polling harder does not help:
# every retry re-reads the very document the script poisoned.
#
# The per-version document is a different URL that was never probed, so it is
# never negatively cached, and it answers immediately and correctly.
#
# Returns $null for "no usable answer" (probe disabled, offline, proxy, non-404
# error) so npm's own verdict stands untouched. The result is only ever used to
# DISPROVE a 404, never to assert one — an anonymous probe against a private
# package would 404 legitimately, and that must not become a false negative.
function Get-RegistryVersionManifest([string]$PackageName, [string]$Version) {
  if (-not $registryProbeEnabled) {
    return $null
  }
  try {
    $response = Invoke-WebRequest -Uri (Get-RegistryVersionUrl $PackageName $Version) -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop
  } catch {
    $webResponse = $null
    if ($null -ne $_.Exception -and $null -ne $_.Exception.PSObject.Properties['Response']) {
      $webResponse = $_.Exception.Response
    }
    if ($null -ne $webResponse -and [int]$webResponse.StatusCode -eq 404) {
      return [pscustomobject]@{ Found = $false; Manifest = $null }
    }
    return $null
  }
  if ($response.StatusCode -ne 200) {
    return $null
  }
  try {
    return [pscustomobject]@{ Found = $true; Manifest = ($response.Content | ConvertFrom-Json) }
  } catch {
    return $null
  }
}

function Test-NpmVersionExists([string]$PackageName, [string]$Version) {
  $specifier = "$PackageName@$Version"
  $result = Invoke-NpmCapture @('view', $specifier, 'version', '--registry', $registry)
  if ($result.ExitCode -eq 0) {
    return $true
  }
  if ($result.Text -match '(?i)E404|404\s+Not\s+Found|is not in this registry') {
    $probe = Get-RegistryVersionManifest $PackageName $Version
    if ($null -ne $probe -and $probe.Found) {
      return $true
    }
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
  throw @"
$PackageName@$Version was published but is not queryable after $RegistryRetries attempts.
This is not proof the publish failed. 'npm view' reads the package document, which the
registry CDN may still be serving from a cached 404. Read the per-version document — a
different URL, never negatively cached — before concluding anything:
  curl -s -o NUL -w "%{http_code}" "$(Get-RegistryVersionUrl $PackageName $Version)"
200 there means the release is live and only this verification lagged; finish with
.\publish-latest.ps1 -Resume. 404 there means the publish really did not land.
"@
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
  $cliCoreRange = $cli.dependencies.'@aragon-agent/core'
  $lockCoreRange = $lockMetadata.cliCoreRange
  if ($cliCoreRange -ne $expectedCoreRange -or $lockCoreRange -ne $expectedCoreRange) {
    throw "CLI must depend on $expectedCoreRange in both package.json and package-lock.json"
  }

  $binProperties = Get-PropertyList (Get-ObjectProperty $cli 'bin')
  if ($binProperties.Count -ne 1 -or $binProperties[0].Name -ne $cliBinName -or $binProperties[0].Value -ne $cliBinSourcePath) {
    throw "CLI package must expose only bin.$cliBinName = $cliBinSourcePath"
  }
  $lockBinProperties = Get-PropertyList (Get-ObjectProperty $lockMetadata 'cliBin')
  if ($lockBinProperties.Count -ne 1 -or $lockBinProperties[0].Name -ne $cliBinName -or $lockBinProperties[0].Value -ne $cliBinNormalizedPath) {
    throw "CLI lockfile metadata must expose only npm-normalized bin.$cliBinName = $cliBinNormalizedPath"
  }

  return [pscustomobject]@{
    CoreVersion = [string]$core.version
    CliVersion = [string]$cli.version
    CoreRange = [string]$cliCoreRange
  }
}

function Invoke-NpmPublish([string]$Workspace) {
  $otpWasPresent = Test-Path Env:npm_config_otp
  $originalOtp = if ($otpWasPresent) { $env:npm_config_otp } else { $null }
  $secureOtp = $null
  $publishOtp = $null
  try {
    if ($PromptForOtp) {
      $secureOtp = Read-Host "npm OTP for $Workspace" -AsSecureString
      $publishOtp = ([Net.NetworkCredential]::new('', $secureOtp)).Password
      if ([string]::IsNullOrWhiteSpace($publishOtp)) {
        throw "npm OTP for $Workspace cannot be empty"
      }
      $env:npm_config_otp = $publishOtp
    }
    Invoke-NpmCommand @('publish', '-w', $Workspace, '--access', 'public', '--registry', $registry)
  } finally {
    if ($otpWasPresent) {
      $env:npm_config_otp = $originalOtp
    } else {
      Remove-Item Env:npm_config_otp -ErrorAction SilentlyContinue
    }
    $publishOtp = $null
    if ($null -ne $secureOtp) {
      $secureOtp.Dispose()
    }
  }
}

function Assert-CliPackContents {
  $arguments = @('pack', '-w', 'packages/cli', '--dry-run', '--json')
  Write-Host "> npm $($arguments -join ' ')" -ForegroundColor DarkGray
  $result = Invoke-NpmCapture $arguments
  if ($result.ExitCode -ne 0) {
    throw "npm pack failed ($($result.ExitCode)) for packages/cli:`n$($result.Text)"
  }

  $payload = ConvertFrom-NpmJsonText $result.Text
  $entries = @($payload)
  if ($entries.Count -ne 1) {
    throw "CLI pack output is not a single JSON result:`n$($result.Text)"
  }

  $files = @(Get-ObjectProperty $entries[0] 'files')
  $paths = @($files | ForEach-Object { [string](Get-ObjectProperty $_ 'path') })
  foreach ($requiredPath in @('dist/launcher.js', 'dist/cli.js', 'runtime/insecure-tls-warning.cjs')) {
    if ($paths -notcontains $requiredPath) {
      throw "CLI pack is missing required file '$requiredPath'"
    }
  }
}

function Invoke-ReleaseChecks($PackageState) {
  Invoke-NpmCommand @('test')
  Invoke-NpmCommand @('run', 'build')
  Invoke-NpmCommand @('run', 'verify:dist', '-w', 'packages/core')
  # Brand gate. Must run AFTER `npm run build` (or it scans a stale/absent dist)
  # and BEFORE `npm publish` (or it is decorative). Invoked as an npm script, not
  # as `& node ...`, so the fake-npm fixture can intercept it like every other
  # call in this function.
  Invoke-NpmCommand @('run', 'verify:brand')
  Invoke-NpmCommand @('pack', '-w', 'packages/core', '--dry-run', '--json')
  Assert-CliPackContents

  Write-Host '> node packages/cli/dist/launcher.js --version' -ForegroundColor DarkGray
  $versionOutput = @(& node 'packages/cli/dist/launcher.js' '--version' 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "CLI dist smoke failed ($LASTEXITCODE): $($versionOutput -join [Environment]::NewLine)"
  }
  $reportedVersion = ($versionOutput | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_.Length -gt 0 } | Select-Object -Last 1)
  if ($reportedVersion -ne $PackageState.CliVersion) {
    throw "CLI dist reports '$reportedVersion', expected '$($PackageState.CliVersion)'"
  }
}

function Assert-PublishedCliMetadata([string]$Version) {
  $result = Invoke-NpmCapture @('view', "@aragon-agent/cli@$Version", 'version', 'bin', '--json', '--registry', $registry)
  if ($result.ExitCode -eq 0) {
    $metadata = ConvertFrom-NpmJsonText $result.Text
    if ($null -eq $metadata) {
      throw "Published CLI metadata is not valid JSON:`n$($result.Text)"
    }
  } else {
    # Wait-ForNpmVersion can converge on the per-version document while `npm view`
    # is still being served a cached 404 for the package document; without the same
    # fallback here, that lag would fail the run one line after it was survived.
    $probe = Get-RegistryVersionManifest '@aragon-agent/cli' $Version
    if ($null -eq $probe -or -not $probe.Found) {
      throw "Published CLI metadata is not queryable:`n$($result.Text)"
    }
    $metadata = $probe.Manifest
  }

  $publishedVersion = [string](Get-ObjectProperty $metadata 'version')
  if ($publishedVersion -ne $Version) {
    throw "Published CLI metadata reports version '$publishedVersion', expected '$Version'"
  }

  $binProperties = Get-PropertyList (Get-ObjectProperty $metadata 'bin')
  if ($binProperties.Count -ne 1 -or $binProperties[0].Name -ne $cliBinName) {
    $aliases = ($binProperties | ForEach-Object { $_.Name }) -join ', '
    throw "Published CLI metadata must expose only bin.$cliBinName; got: $aliases"
  }
  # The registry serves the npm-normalized path, never the './' form in the source manifest.
  $publishedBinPath = ConvertTo-NormalizedBinPath ([string]$binProperties[0].Value)
  if ($publishedBinPath -ne $cliBinNormalizedPath) {
    throw "Published CLI metadata exposes bin.$cliBinName = '$($binProperties[0].Value)', expected '$cliBinNormalizedPath'"
  }
}

function Assert-NpmAuthentication {
  Write-Host "> npm whoami --registry $registry" -ForegroundColor DarkGray
  $result = Invoke-NpmCapture @('whoami', '--registry', $registry)
  if ($result.ExitCode -eq 0) {
    $account = ($result.Output | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_.Length -gt 0 } | Select-Object -Last 1)
    Write-Host "npm account: $account" -ForegroundColor DarkGray
    return
  }
  if ($result.Text -match '(?i)E401|ENEEDAUTH|Unauthorized') {
    throw @"
Not authenticated against $registry (npm credentials are missing or expired).
Log in, then re-run this script:
  npm login --scope "@aragon-agent" --registry "$registry" --auth-type web
  npm whoami --registry "$registry"
npm reported:
$($result.Text)
"@
  }
  throw "Unable to verify npm authentication:`n$($result.Text)"
}

# Surfaces a missing @aragon-agent organization BEFORE `npm publish`, where the
# same problem arrives as a bare 404 `Scope not found` — after the version files
# have already been bumped and after $publishMayHaveStarted has been set, so the
# script's own advice ("run -Resume") is misleading at exactly the moment it
# matters most. Nothing was published in that case; create the org, discard the
# bump, and run a full publish again.
#
# WARNING, NOT AN ERROR, on purpose. A brand-new empty org has no packages to
# list, so this command is EXPECTED to fail on the very first publish under a
# new scope; so does a CI token with restricted read scope. Making it fatal
# would block legitimate releases in order to catch one setup mistake.
function Assert-ScopePublishable {
  Write-Host "> npm access list packages @aragon-agent --registry $registry" -ForegroundColor DarkGray
  $result = Invoke-NpmCapture @('access', 'list', 'packages', '@aragon-agent', '--registry', $registry)
  if ($result.ExitCode -ne 0) {
    Write-Warning @"
Unable to confirm ownership of the @aragon-agent scope. If this is the FIRST
publish under this scope, create the organization on npmjs.com first; otherwise
``npm publish`` fails with 404 Scope not found and nothing is published. npm reported:
$($result.Text)
"@
  }
}

if ($DryRun -and $Resume) {
  throw '-DryRun and -Resume cannot be used together'
}

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $coreManifestPath)) -or
    -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $cliManifestPath)) -or
    -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $lockfilePath))) {
  throw 'publish-latest.ps1 must run from an AragonAgent source tree containing both workspaces and package-lock.json'
}

Push-Location $PSScriptRoot
try {
  Enable-InsecureTlsWarningFilterForNodeChildren
  Assert-RepositoryState
  Save-VersionFileSnapshots

  $oldCoreVersion = [string](Read-JsonFile $coreManifestPath).version
  $oldCliVersion = [string](Read-JsonFile $cliManifestPath).version

  if (-not $Resume) {
    # --no-workspaces-update is load-bearing, not tidiness. `npm version` otherwise
    # reifies the tree the instant Core's version changes, while packages/cli still
    # declares the PREVIOUS range (e.g. ^0.1.2). On a minor/major bump the local
    # workspace no longer satisfies that range, so npm goes to the registry for it.
    #
    # Under the pre-rename scope that lookup quietly SUCCEEDED — the previously
    # published Core was there to download — so the inconsistency never surfaced.
    # A freshly created scope has no such fallback: the very first `-Bump minor`
    # dies at step one with `E404 ... is not in this registry`.
    #
    # Skipping the intermediate reify costs nothing: the two installs below rebuild
    # the lockfile and node_modules once the CLI's range already points at the new
    # Core version, and Assert-PackageState verifies the result.
    Invoke-NpmCommand @('version', $Bump, '-w', 'packages/core', '--no-git-tag-version', '--no-workspaces-update')
    $newCoreVersion = [string](Read-JsonFile $coreManifestPath).version
    Invoke-NpmCommand @('pkg', 'set', "dependencies.@aragon-agent/core=^$newCoreVersion", '-w', 'packages/cli')
    Invoke-NpmCommand @('version', $Bump, '-w', 'packages/cli', '--no-git-tag-version', '--no-workspaces-update')
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
    return
  }

  Assert-NpmAuthentication
  Assert-ScopePublishable
  $coreExists = Test-NpmVersionExists '@aragon-agent/core' $packageState.CoreVersion
  $cliExists = Test-NpmVersionExists '@aragon-agent/cli' $packageState.CliVersion

  if (-not $Resume -and ($coreExists -or $cliExists)) {
    $existing = @()
    if ($coreExists) { $existing += "@aragon-agent/core@$($packageState.CoreVersion)" }
    if ($cliExists) { $existing += "@aragon-agent/cli@$($packageState.CliVersion)" }
    throw "Refusing to overwrite published version(s): $($existing -join ', ')"
  }

  if (-not $coreExists) {
    $publishMayHaveStarted = $true
    Invoke-NpmPublish 'packages/core'
    Wait-ForNpmVersion '@aragon-agent/core' $packageState.CoreVersion
  } else {
    Write-Host "Core $($packageState.CoreVersion) already exists; skipping it." -ForegroundColor Yellow
  }

  if (-not $cliExists) {
    $publishMayHaveStarted = $true
    Invoke-NpmPublish 'packages/cli'
    Wait-ForNpmVersion '@aragon-agent/cli' $packageState.CliVersion
  } else {
    Write-Host "CLI $($packageState.CliVersion) already exists; skipping it." -ForegroundColor Yellow
  }

  Assert-PublishedCliMetadata $packageState.CliVersion
  Write-Host "Published @aragon-agent/core@$($packageState.CoreVersion) and @aragon-agent/cli@$($packageState.CliVersion)." -ForegroundColor Green
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
  try {
    Restore-NodeOptions
  } finally {
    Pop-Location
  }
}
