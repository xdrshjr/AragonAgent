<#
.SYNOPSIS
  Read-only preflight doctor for the one-click Windows packaging scripts.

.DESCRIPTION
  Answers one question: can THIS machine package packages\desktop right now?
  It reports the toolchain, the repo layout, the installed modules, the engine
  packages (installed from the npm registry - core and cli are closed source and
  are not part of this repository), the TUI dist, disk space, write access and
  the two environment traps that break the chain (ELECTRON_RUN_AS_NODE, and a
  non-UTF-8 console code page on a checkout whose path is not ASCII).

  READ ONLY: nothing is installed, nothing is deleted, no project file is
  touched. The only write is a uniquely named temp file inside <DesktopRoot>,
  created and removed inside the same check. The probes are version queries
  (`node --version`, `npm --version` once, `chcp`, package.json reads) run
  through cmd.exe, because the npm and npx shims are .cmd files on Windows and
  the npm.ps1 wrapper beside them mangles a scripted call.

  Exit code 0 when no check FAILED, 1 when at least one did. Warnings never
  change the exit code.

.PARAMETER DesktopRoot
  The packages\desktop directory. Default: parent-parent of this script, i.e.
  <scripts>\pack\..\.. which is packages\desktop.

.PARAMETER Quiet
  Print only the rows that are not PASS, then the summary and the fix lines.

.PARAMETER Json
  Print one JSON object and nothing else (no table, no summary).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\pack\Invoke-PackDoctor.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\pack\Invoke-PackDoctor.ps1 -Json
#>

[CmdletBinding()]
param(
  # Resolved at run time from $PSScriptRoot (see Resolve-DoctorRoots), so -File,
  # dot-sourcing and a moved pack\ directory all land on packages\desktop.
  [string]$DesktopRoot = '',

  [switch]$Quiet,

  [switch]$Json
)

$ErrorActionPreference = 'Stop'

$script:StatusPass = 'PASS'
$script:StatusWarn = 'WARN'
$script:StatusFail = 'FAIL'

# A failed check needs this much room for the NSIS installer, app.asar and the
# staged engine; between the two budgets the build usually still fits.
$script:FailBudgetBytes = 3GB
$script:WarnBudgetBytes = 8GB

$script:VersionCache = @{}
$script:PackageCache = @{}
$script:SizeFormatter = $null
$script:DesktopDir = ''
$script:RepoDir = ''
$script:SelfPath = $PSCommandPath
$script:NodeMinimum = 20

# --- result builders ---------------------------------------------------------

function New-PassResult {
  param([string]$Name, [string]$Detail = '', [string]$Version = '-')
  return [pscustomobject]@{
    Name = $Name
    Status = $script:StatusPass
    Version = $Version
    Detail = $Detail
    Fix = ''
  }
}

function New-WarnResult {
  param([string]$Name, [string]$Detail = '', [string]$Fix = '', [string]$Version = '-')
  return [pscustomobject]@{
    Name = $Name
    Status = $script:StatusWarn
    Version = $Version
    Detail = $Detail
    Fix = $Fix
  }
}

function New-FailResult {
  param([string]$Name, [string]$Detail = '', [string]$Fix = '', [string]$Version = '-')
  return [pscustomobject]@{
    Name = $Name
    Status = $script:StatusFail
    Version = $Version
    Detail = $Detail
    Fix = $Fix
  }
}

# --- paths and small helpers -------------------------------------------------

function Resolve-DoctorRoots {
  param([string]$RequestedDesktopRoot)

  $desktop = $RequestedDesktopRoot
  if ([string]::IsNullOrWhiteSpace($desktop)) {
    $desktop = Join-Path $PSScriptRoot '..\..'
  }
  $desktopFull = [System.IO.Path]::GetFullPath($desktop)
  $repoFull = [System.IO.Path]::GetFullPath((Join-Path $desktopFull '..\..'))
  return [pscustomobject]@{
    Desktop = $desktopFull.TrimEnd('\')
    Repo = $repoFull.TrimEnd('\')
  }
}

# PackCommon.psm1 is written by another agent and may not exist yet: reuse its
# size formatter when it is there, fall back to the local one when it is not.
function Initialize-PackCommonReuse {
  param([string]$PackDirectory)

  $modulePath = Join-Path $PackDirectory 'PackCommon.psm1'
  if (-not (Test-Path -LiteralPath $modulePath)) { return }
  try {
    $importArgs = @{
      Name = $modulePath
      Force = $true
      ErrorAction = 'Stop'
      WarningAction = 'SilentlyContinue'
    }
    $null = Import-Module @importArgs
    $lookup = @{
      Name = 'Format-PackSize'
      CommandType = 'Function'
      ErrorAction = 'SilentlyContinue'
    }
    $formatter = Get-Command @lookup
    if ($null -ne $formatter) { $script:SizeFormatter = $formatter }
  } catch {
    # A broken or half-written module must never stop the doctor.
    $script:SizeFormatter = $null
  }
}

function Format-SizeFallback {
  param([double]$Bytes)

  if ($Bytes -ge 1GB) { return ('{0:N1} GB' -f ($Bytes / 1GB)) }
  if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
  if ($Bytes -ge 1KB) { return ('{0:N1} KB' -f ($Bytes / 1KB)) }
  return ('{0:N0} B' -f $Bytes)
}

function Format-DoctorSize {
  param([double]$Bytes)

  if ($null -ne $script:SizeFormatter) {
    try {
      $text = [string](& $script:SizeFormatter -Bytes ([long]$Bytes))
      if (-not [string]::IsNullOrWhiteSpace($text)) { return $text.Trim() }
    } catch {
      $script:SizeFormatter = $null
    }
  }
  return (Format-SizeFallback -Bytes $Bytes)
}

function Read-JsonFile {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
  } catch {
    return $null
  }
}

# Resolve a tool name to the real executable. `& $Command` is not good enough:
# command precedence puts an ExternalScript before an Application, so `& 'npm'`
# runs npm.ps1, whose PS 5.1 branch rebuilds its own command line from the
# caller's statement text (Invoke-Expression) and throws a parse error - which a
# naive capture records as "no output". The ready-made executable (npm.cmd) is
# what actually has to be run.
function Resolve-DoctorToolPath {
  param([string]$Name)

  # PackCommon.Get-PackToolPath is the shared resolver (Application commands only,
  # plus node_modules\.bin); use it when this run already imported the module.
  $resolver = $null
  try {
    $resolver = Get-Command -Name 'Get-PackToolPath' -CommandType Function -ErrorAction SilentlyContinue
  } catch {
    $resolver = $null
  }
  if ($null -ne $resolver) {
    try {
      $shared = [string](& $resolver -Name $Name -SearchRoot $script:DesktopDir)
      if (-not [string]::IsNullOrWhiteSpace($shared)) { return $shared }
    } catch {
      # fall through to the lookup built into this script
    }
  }

  $application = $null
  try {
    $application = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue |
      Select-Object -First 1
  } catch {
    $application = $null
  }
  if ($null -eq $application) { return $null }
  return ([string]$application.Source)
}

# Run "<exe> <args>" through cmd.exe and bring back stdout, stderr and the exit
# code. A .cmd shim only runs inside a command interpreter, so cmd.exe /d /s /c
# is the reliable carrier; ProcessStartInfo is used instead of Start-Process so
# stderr is captured too and the argument string reaches cmd.exe verbatim.
# Nothing is written to disk.
function Invoke-DoctorProcessText {
  param([string]$FilePath, [string[]]$Arguments = @())

  $result = [pscustomobject]@{
    Text = ''
    StdErr = ''
    ExitCode = -1
    TimedOut = $false
  }

  $shell = [string]$env:ComSpec
  if ([string]::IsNullOrWhiteSpace($shell)) { $shell = 'cmd.exe' }
  $argumentLine = ''
  if ($null -ne $Arguments) { $argumentLine = ($Arguments -join ' ') }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $shell
  # /s keeps cmd.exe from stripping the quotes around the (possibly spaced) path.
  $startInfo.Arguments = '/d /s /c ""' + $FilePath + '" ' + $argumentLine + '"'
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  $process = $null
  try {
    $process = [System.Diagnostics.Process]::Start($startInfo)
    # Read both pipes before waiting, or a full pipe buffer deadlocks the wait.
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $result.Text = [string]$stdout
    $result.StdErr = [string]$stderr
    if ($process.WaitForExit(15000)) {
      $result.ExitCode = [int]$process.ExitCode
    } else {
      $result.TimedOut = $true
      try { $process.Kill() } catch { }
    }
  } catch {
    $result.StdErr = $_.Exception.Message
  } finally {
    if ($null -ne $process) {
      try { $process.Dispose() } catch { }
    }
  }
  return $result
}

# First line that looks like a version, else the first non-empty line that
# carries a digit - which rejects error text ("Invalid code page", "Could not
# determine Node.js install directory") so a failing tool cannot masquerade as a
# passing one. No version string in the world is free of digits.
function Get-DoctorVersionLine {
  param([string]$Text)

  if ([string]::IsNullOrEmpty($Text)) { return '' }
  $fallback = ''
  foreach ($line in ($Text -split "`r?`n")) {
    $trimmed = $line.Trim()
    if ($trimmed -eq '') { continue }
    if (-not [regex]::IsMatch($trimmed, '\d')) { continue }
    if ($fallback -eq '') { $fallback = $trimmed }
    if ([regex]::IsMatch($trimmed, '\d+\.\d+')) { return $trimmed }
  }
  return $fallback
}

# One probe per tool per run (npm --version costs a few hundred ms on Windows).
# The answer carries the exit code and the stderr so a failure says why.
function Get-DoctorToolVersion {
  param([string]$Name, [string[]]$Arguments = @('--version'))

  $key = $Name + ' ' + ($Arguments -join ' ')
  if ($script:VersionCache.ContainsKey($key)) { return $script:VersionCache[$key] }

  $result = [pscustomobject]@{
    Version = ''
    ExitCode = -1
    StdErr = ''
    Path = ''
    TimedOut = $false
    Attempt = ''
  }

  $toolPath = Resolve-DoctorToolPath -Name $Name
  if ([string]::IsNullOrWhiteSpace($toolPath)) {
    $result.StdErr = $Name + ' is not on PATH'
    $script:VersionCache[$key] = $result
    return $result
  }
  $result.Path = $toolPath

  # Attempt 1: through cmd.exe, the only way a .cmd shim runs.
  $first = Invoke-DoctorProcessText -FilePath $toolPath -Arguments $Arguments
  $result.ExitCode = $first.ExitCode
  $result.StdErr = [string]$first.StdErr
  $result.TimedOut = $first.TimedOut
  $line = Get-DoctorVersionLine -Text ([string]$first.Text)
  if ($line -ne '') {
    $result.Version = $line
    $result.Attempt = 'cmd.exe'
    $script:VersionCache[$key] = $result
    return $result
  }

  # Attempt 2: the resolved executable directly. stderr goes to $null here on
  # purpose: PS 5.1 wraps a native stderr line in an error record whose position
  # text contains digits, and that must never be mistaken for a version. The
  # stderr of attempt 1 is the one that gets reported.
  $previousPreference = $ErrorActionPreference
  $direct = ''
  $directExit = $null
  try {
    $ErrorActionPreference = 'Continue'
    $direct = (& $toolPath @Arguments 2>$null | Out-String)
    $directExit = $LASTEXITCODE
  } catch {
    $direct = ''
    $directExit = $null
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  $line = Get-DoctorVersionLine -Text ([string]$direct)
  if ($line -ne '') {
    $result.Version = $line
    $result.Attempt = 'direct'
    if ($null -ne $directExit) { $result.ExitCode = [int]$directExit }
    $script:VersionCache[$key] = $result
    return $result
  }
  if ([string]::IsNullOrWhiteSpace($result.StdErr)) {
    $text = ([string]$direct).Trim()
    if ($text -ne '') { $result.StdErr = $text }
  }
  $script:VersionCache[$key] = $result
  return $result
}

# Failure detail for a silent probe: the exit code and the stderr text, because
# "returned nothing" alone is what made this doctor lie about a healthy machine.
function Format-DoctorProbeFailure {
  param([string]$Name, [object]$Probe)

  $prefix = '{0} --version returned nothing' -f $Name
  if ($Probe.TimedOut) { $prefix = '{0} --version timed out' -f $Name }
  $err = ([string]$Probe.StdErr).Trim()
  if ($err -eq '') { $err = '(no stderr)' }
  $detail = $prefix + ' (exit ' + [string]$Probe.ExitCode + ', stderr: ' + $err + ')'
  return (Limit-DoctorText -Text $detail -Maximum 200)
}

# Node's resolution walks up, so a workspace install may hoist a devDependency to
# the repo root - which is exactly what this checkout does for electron.
function Find-InstalledPackage {
  param([string]$PackageName)

  if ($script:PackageCache.ContainsKey($PackageName)) { return $script:PackageCache[$PackageName] }

  $found = $null
  $candidates = @(
    (Join-Path $script:DesktopDir ('node_modules\' + $PackageName + '\package.json')),
    (Join-Path $script:RepoDir ('node_modules\' + $PackageName + '\package.json'))
  )
  foreach ($path in $candidates) {
    $manifest = Read-JsonFile -Path $path
    if ($null -eq $manifest) { continue }
    if ([string]::IsNullOrWhiteSpace([string]$manifest.version)) { continue }
    $where = 'repo root node_modules (hoisted)'
    if ($path.StartsWith($script:DesktopDir, 'OrdinalIgnoreCase')) {
      $where = 'packages\desktop\node_modules'
    }
    $found = [pscustomobject]@{ Version = [string]$manifest.version; Where = $where }
    break
  }
  $script:PackageCache[$PackageName] = $found
  return $found
}

function Test-DoctorNodeMinimum {
  param([string]$DesktopDirectory)

  $manifest = Read-JsonFile -Path (Join-Path $DesktopDirectory 'package.json')
  if ($null -eq $manifest) { return 20 }
  if ($null -eq $manifest.PSObject.Properties['engines']) { return 20 }
  if ($null -eq $manifest.engines.PSObject.Properties['node']) { return 20 }
  $match = [regex]::Match([string]$manifest.engines.node, '(\d+)')
  if ($match.Success) { return [int]$match.Value }
  return 20
}

# --- checks (table order) ----------------------------------------------------

function Test-DoctorPowerShell {
  $version = $PSVersionTable.PSVersion
  $edition = 'Desktop'
  if ($PSVersionTable.ContainsKey('PSEdition')) { $edition = [string]$PSVersionTable.PSEdition }
  $is64 = [Environment]::Is64BitProcess
  $bits = '32-bit process'
  if ($is64) { $bits = '64-bit process' }
  $detail = '{0} edition, {1}' -f $edition, $bits
  $text = $version.ToString()

  if ($version -lt [version]'5.1') {
    $fix = 'run this with Windows PowerShell 5.1 or newer: powershell -NoProfile -File '
    $fix = $fix + $script:SelfPath
    return (New-FailResult -Name 'powershell' -Version $text -Detail $detail -Fix $fix)
  }
  if (-not $is64) {
    $fix = 'launch the 64-bit shell (%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe),'
    $fix = $fix + ' not SysWOW64'
    return (New-FailResult -Name 'powershell' -Version $text -Detail $detail -Fix $fix)
  }
  return (New-PassResult -Name 'powershell' -Version $text -Detail $detail)
}

function Test-DoctorExecutionPolicy {
  $policy = 'Undefined'
  try {
    $policy = [string](Get-ExecutionPolicy)
  } catch {
    $detail = 'Get-ExecutionPolicy failed: ' + $_.Exception.Message
    $fix = 'inspect the scopes with Get-ExecutionPolicy -List; group policy may hide the cause'
    return (New-WarnResult -Name 'execution-policy' -Detail $detail -Fix $fix)
  }

  $detail = 'effective policy: ' + $policy
  if ($policy -eq 'Restricted' -or $policy -eq 'AllSigned') {
    $fix = 'start the packaging script with: powershell -NoProfile -ExecutionPolicy Bypass -File'
    $fix = $fix + ' <script>'
    return (New-WarnResult -Name 'execution-policy' -Version $policy -Detail $detail -Fix $fix)
  }
  return (New-PassResult -Name 'execution-policy' -Version $policy -Detail $detail)
}

function Test-DoctorOperatingSystem {
  $osVersion = [Environment]::OSVersion.Version
  $build = [string]$osVersion.Build
  $release = ''
  $info = $null
  $registryPath = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
  try {
    $info = Get-ItemProperty -Path $registryPath -ErrorAction Stop
  } catch {
    $info = $null
  }
  if ($null -ne $info) {
    if ($info.DisplayVersion) { $release = [string]$info.DisplayVersion }
    if ($info.CurrentBuild) { $build = [string]$info.CurrentBuild }
  }

  # The registry still says "Windows 10 Pro" on Windows 11; the build number is
  # the honest source, and it costs nothing (WMI would cost ~300 ms).
  $product = 'Windows 10'
  $buildNumber = 0
  if ([int]::TryParse($build, [ref]$buildNumber) -and $buildNumber -ge 22000) {
    $product = 'Windows 11'
  }
  $name = $product
  if ($release -ne '') { $name = $product + ' ' + $release }

  $arch = [string]$env:PROCESSOR_ARCHITECTURE
  if ([string]::IsNullOrWhiteSpace($arch)) { $arch = 'unknown' }
  $detail = '{0} build {1}, {2}' -f $name, $build, $arch

  if ($arch -eq 'AMD64') {
    return (New-PassResult -Name 'os' -Version $build -Detail $detail)
  }
  if ($arch -eq 'ARM64') {
    $detail = $detail + ' (x64 NSIS target; the result runs emulated)'
    return (New-WarnResult -Name 'os' -Version $build -Detail $detail)
  }
  $fix = 'use a 64-bit x64 or ARM64 Windows host; electron-builder.yml builds an x64 NSIS target'
  return (New-FailResult -Name 'os' -Version $build -Detail $detail -Fix $fix)
}

function Test-DoctorNode {
  $probe = Get-DoctorToolVersion -Name 'node'
  if ([string]::IsNullOrWhiteSpace([string]$probe.Path)) {
    $fix = 'install Node.js 20 LTS or newer from https://nodejs.org/ and reopen the shell'
    return (New-FailResult -Name 'node' -Detail 'node not found in PATH' -Fix $fix)
  }
  $raw = [string]$probe.Version
  if ([string]::IsNullOrWhiteSpace($raw)) {
    $fix = 'node is on PATH but "node --version" failed; reinstall Node.js 20 LTS from'
    $fix = $fix + ' https://nodejs.org/'
    $detail = Format-DoctorProbeFailure -Name 'node' -Probe $probe
    return (New-FailResult -Name 'node' -Detail $detail -Fix $fix)
  }

  $minimum = $script:NodeMinimum
  $match = [regex]::Match($raw, '(\d+)')
  $major = -1
  if ($match.Success) { $major = [int]$match.Value }
  $detail = 'major {0}, requires {1} or newer' -f $major, $minimum

  if ($major -lt $minimum) {
    $fix = 'install Node.js {0} LTS or newer from https://nodejs.org/ (now {1})' -f $minimum, $raw
    return (New-FailResult -Name 'node' -Version $raw -Detail $detail -Fix $fix)
  }
  return (New-PassResult -Name 'node' -Version $raw -Detail $detail)
}

function Test-DoctorNpm {
  $probe = Get-DoctorToolVersion -Name 'npm'
  if ([string]::IsNullOrWhiteSpace([string]$probe.Path)) {
    $fix = 'npm ships with Node.js: install Node.js 20 LTS from https://nodejs.org/ and'
    $fix = $fix + ' reopen the shell'
    return (New-FailResult -Name 'npm' -Detail 'npm not found in PATH' -Fix $fix)
  }
  $raw = [string]$probe.Version
  if ([string]::IsNullOrWhiteSpace($raw)) {
    $fix = 'npm is on PATH but "npm --version" failed; reinstall Node.js 20 LTS from'
    $fix = $fix + ' https://nodejs.org/'
    $detail = Format-DoctorProbeFailure -Name 'npm' -Probe $probe
    return (New-FailResult -Name 'npm' -Detail $detail -Fix $fix)
  }
  return (New-PassResult -Name 'npm' -Version $raw -Detail ('usable at ' + $probe.Path))
}

function Test-DoctorRepoLayout {
  # This repository has exactly two workspace packages: packages/tui and
  # packages/desktop. core and cli are closed source and come from the npm
  # registry, so their absence is the expected shape here - never a failure.
  $missing = @()
  foreach ($package in @('tui', 'desktop')) {
    $manifestPath = Join-Path $script:RepoDir ('packages\' + $package + '\package.json')
    if (-not (Test-Path -LiteralPath $manifestPath)) { $missing += $package }
  }

  $localEngine = @()
  foreach ($package in @('core', 'cli')) {
    $manifestPath = Join-Path $script:RepoDir ('packages\' + $package + '\package.json')
    if (Test-Path -LiteralPath $manifestPath) { $localEngine += $package }
  }
  $engineNote = 'engine from npm registry (closed source)'
  if ($localEngine.Count -gt 0) { $engineNote = 'engine packages also present locally: ' + ($localEngine -join ',') }

  $rootManifest = Read-JsonFile -Path (Join-Path $script:RepoDir 'package.json')
  $hasWorkspaces = $false
  if ($null -ne $rootManifest) {
    $hasWorkspaces = ($null -ne $rootManifest.PSObject.Properties['workspaces'])
  }

  if ($missing.Count -gt 0) {
    $detail = 'missing package.json for: ' + ($missing -join ',')
    $packagesDir = Join-Path $script:RepoDir 'packages'
    if (Test-Path -LiteralPath $packagesDir) {
      $fix = 'this checkout is incomplete: ' + $packagesDir + ' has no ' + ($missing -join ',') + ' folder;'
      $fix = $fix + ' clone the repository again (packages\tui and packages\desktop are both required)'
    } else {
      $fix = 'the repo root resolved to ' + $script:RepoDir + ', which has no packages folder;'
      $fix = $fix + ' run the doctor from inside a checkout or pass -DesktopRoot <checkout>\packages\desktop'
    }
    return (New-FailResult -Name 'repo-layout' -Detail $detail -Fix $fix)
  }
  if (-not $hasWorkspaces) {
    $detail = 'packages\tui and packages\desktop present, but the root package.json has no workspaces'
    $fix = 'restore the "workspaces" field ("packages/tui", "packages/desktop") in '
    $fix = $fix + (Join-Path $script:RepoDir 'package.json')
    return (New-FailResult -Name 'repo-layout' -Detail $detail -Fix $fix)
  }
  $detail = 'tui,desktop manifests; root declares workspaces; ' + $engineNote
  return (New-PassResult -Name 'repo-layout' -Version '2/2' -Detail $detail)
}

function Test-DoctorDesktopNodeModules {
  $modulesPath = Join-Path $script:DesktopDir 'node_modules'
  if (Test-Path -LiteralPath $modulesPath) {
    $detail = 'packages\desktop\node_modules exists'
    return (New-PassResult -Name 'desktop-node-modules' -Version 'present' -Detail $detail)
  }
  $detail = 'packages\desktop\node_modules is absent'
  $fix = 'run npm install at the repo root: cd /d "' + $script:RepoDir + '" then npm install'
  return (New-FailResult -Name 'desktop-node-modules' -Version 'missing' -Detail $detail -Fix $fix)
}

function Test-DoctorElectronDependency {
  $found = Find-InstalledPackage -PackageName 'electron'
  if ($null -eq $found) {
    $detail = 'electron not found in desktop or repo node_modules'
    $fix = 'run npm install --include=dev at the repo root: cd /d "' + $script:RepoDir + '"'
    $fix = $fix + ' (electron is a devDependency)'
    return (New-FailResult -Name 'electron' -Version 'missing' -Detail $detail -Fix $fix)
  }
  return (New-PassResult -Name 'electron' -Version $found.Version -Detail $found.Where)
}

function Test-DoctorElectronBuilder {
  $found = Find-InstalledPackage -PackageName 'electron-builder'
  if ($null -eq $found) {
    $detail = 'electron-builder not found in desktop or repo node_modules'
    $fix = 'run npm install --include=dev at the repo root: cd /d "' + $script:RepoDir + '"'
    $fix = $fix + ' (electron-builder is a devDependency)'
    return (New-FailResult -Name 'electron-builder' -Version 'missing' -Detail $detail -Fix $fix)
  }
  $detail = $found.Where
  $binary = Join-Path $script:RepoDir 'node_modules\.bin\electron-builder.cmd'
  if (Test-Path -LiteralPath $binary) { $detail = $detail + ', .bin shim present' }
  return (New-PassResult -Name 'electron-builder' -Version $found.Version -Detail $detail)
}

function Test-DoctorEngineDist {
  # The engine is installed from the npm registry: @aragon-agent/core and @aragon-agent/cli
  # are closed source and only have to RESOLVE from node_modules - nothing in this
  # repository compiles them. The TUI is different: it is a workspace sibling, and the
  # desktop imports @aragon-agent/tui/model/*, which the package export map resolves to
  # packages\tui\dist, so that dist has to exist before the desktop build runs.
  $engineNames = @('@aragon-agent/core', '@aragon-agent/cli', '@aragon-agent/tui')
  $installed = @()
  $missing = @()
  foreach ($name in $engineNames) {
    $found = Find-InstalledPackage -PackageName $name
    if ($null -eq $found) { $missing += $name; continue }
    $installed += ($name + '@' + $found.Version)
  }

  $tuiDist = Join-Path $script:RepoDir 'packages\tui\dist'
  $hasTuiDist = (Test-Path -LiteralPath (Join-Path $tuiDist 'index.d.ts'))
  $tuiNote = 'packages\tui\dist present'
  if (-not $hasTuiDist) { $tuiNote = 'packages\tui\dist is missing (the desktop imports @aragon-agent/tui/model/*)' }

  $repoPrefix = 'cd /d "' + $script:RepoDir + '" then '
  $buildFix = $repoPrefix + 'npm run build -w packages/tui (or npm run build for both packages)'
  $installFix = $repoPrefix + 'npm install'

  $declared = 0
  $desktopManifest = Read-JsonFile -Path (Join-Path $script:DesktopDir 'package.json')
  if ($null -ne $desktopManifest) {
    if ($null -ne $desktopManifest.PSObject.Properties['dependencies']) {
      foreach ($name in $engineNames) {
        if ($null -ne $desktopManifest.dependencies.PSObject.Properties[$name]) { $declared = $declared + 1 }
      }
    }
  }

  if ($missing.Count -gt 0) {
    $detail = 'not installed yet: ' + ($missing -join ',') + '; ' + $tuiNote
    if ($installed.Count -gt 0) { $detail = 'installed: ' + ($installed -join ',') + '; ' + $detail }
    if ($declared -eq 0) {
      $fix = 'packages\desktop\package.json must declare @aragon-agent/core, @aragon-agent/cli'
      $fix = $fix + ' and @aragon-agent/tui under "dependencies"'
      return (New-FailResult -Name 'engine-dist' -Version 'missing' -Detail $detail -Fix $fix)
    }
    $fix = $installFix
    if (-not $hasTuiDist) { $fix = $fix + ' ; then build the TUI: npm run build -w packages/tui' }
    return (New-WarnResult -Name 'engine-dist' -Version 'missing' -Detail $detail -Fix $fix)
  }

  $detail = 'resolved from npm: ' + ($installed -join ',') + '; ' + $tuiNote
  if (-not $hasTuiDist) {
    return (New-WarnResult -Name 'engine-dist' -Version 'no-tui-dist' -Detail $detail -Fix $buildFix)
  }
  return (New-PassResult -Name 'engine-dist' -Version '3/3' -Detail $detail)
}

function Test-DoctorDiskSpace {
  $volumeRoot = [System.IO.Path]::GetPathRoot($script:DesktopDir)
  $driveName = $volumeRoot.TrimEnd('\').TrimEnd(':')
  $freeBytes = 0
  $totalBytes = 0
  $known = $false

  try {
    $drive = Get-PSDrive -Name $driveName -ErrorAction Stop
    if ($null -ne $drive.Free -and $null -ne $drive.Used) {
      $freeBytes = [double]$drive.Free
      $totalBytes = [double]$drive.Free + [double]$drive.Used
      $known = $true
    }
  } catch {
    $known = $false
  }

  if (-not $known) {
    $detail = 'free space unknown for ' + $volumeRoot
    $fix = 'check the volume by hand (Get-PSDrive -Name ' + $driveName + ');'
    $fix = $fix + ' packaging needs 3 GB or more'
    return (New-WarnResult -Name 'disk-space' -Detail $detail -Fix $fix)
  }

  $freeText = Format-DoctorSize -Bytes $freeBytes
  $totalText = Format-DoctorSize -Bytes $totalBytes
  $detail = '{0} free of {1} on {2}' -f $freeText, $totalText, $volumeRoot

  if ($freeBytes -lt $script:FailBudgetBytes) {
    $fix = 'free at least 3 GB on ' + $volumeRoot + '; the NSIS build needs the app, the'
    $fix = $fix + ' asar and the staged engine'
    return (New-FailResult -Name 'disk-space' -Version $freeText -Detail $detail -Fix $fix)
  }
  if ($freeBytes -lt $script:WarnBudgetBytes) {
    $fix = 'free 8 GB or more on ' + $volumeRoot + ' to keep release and release-e2e together'
    return (New-WarnResult -Name 'disk-space' -Version $freeText -Detail $detail -Fix $fix)
  }
  return (New-PassResult -Name 'disk-space' -Version $freeText -Detail $detail)
}

function Test-DoctorWriteAccess {
  $probeName = '.pack-doctor-probe-' + [guid]::NewGuid().ToString('N') + '.tmp'
  $probePath = Join-Path $script:DesktopDir $probeName
  $failure = $null

  try {
    Set-Content -LiteralPath $probePath -Value 'pack-doctor probe' -Encoding ASCII -ErrorAction Stop
  } catch {
    $failure = $_.Exception.Message
  } finally {
    if (Test-Path -LiteralPath $probePath) {
      Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
    }
  }

  if ($null -ne $failure) {
    $detail = 'cannot create a file in packages\desktop'
    $fix = 'grant write access to ' + $script:DesktopDir + ' (or copy the repo elsewhere)'
    return (New-FailResult -Name 'write-access' -Version 'read-only' -Detail $detail -Fix $fix)
  }
  $detail = 'temp file created and removed in packages\desktop'
  return (New-PassResult -Name 'write-access' -Version 'ok' -Detail $detail)
}

function Test-DoctorElectronRunAsNode {
  if (-not (Test-Path -LiteralPath 'Env:ELECTRON_RUN_AS_NODE')) {
    $detail = 'Electron will start as a real Electron'
    return (New-PassResult -Name 'electron-run-as-node' -Version 'not set' -Detail $detail)
  }
  $value = [string]([Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE'))
  if ($value -eq '') { $value = '(empty)' }
  $detail = 'set to ' + $value + ': Electron runs as plain node'
  # Failing rather than warning: with it set the packaged app cannot even import
  # "electron", so every check downstream would report a lie.
  $fix = 'remove the environment variable ELECTRON_RUN_AS_NODE (now: Remove-Item'
  $fix = $fix + ' Env:ELECTRON_RUN_AS_NODE ; permanent: reg delete HKCU\Environment'
  $fix = $fix + ' /F /V ELECTRON_RUN_AS_NODE)'
  return (New-FailResult -Name 'electron-run-as-node' -Version $value -Detail $detail -Fix $fix)
}

function Test-DoctorBuildIcon {
  $iconPath = Join-Path $script:DesktopDir 'build\icon.png'
  if (Test-Path -LiteralPath $iconPath) {
    return (New-PassResult -Name 'build-icon' -Version 'present' -Detail 'build\icon.png exists')
  }
  $detail = 'build\icon.png missing but electron-builder.yml win.icon points at it'
  $fix = 'add packages\desktop\build\icon.png (PNG, 256x256 or larger) or the win target'
  $fix = $fix + ' falls back to the electron-builder default icon'
  return (New-WarnResult -Name 'build-icon' -Version 'missing' -Detail $detail -Fix $fix)
}

function Test-DoctorEnvironment {
  $codePage = ''
  try {
    $chcpOutput = (& chcp.com 2>$null) -join ' '
    $match = [regex]::Match($chcpOutput, '\d+')
    if ($match.Success) { $codePage = $match.Value }
  } catch {
    $codePage = ''
  }

  $culture = 'unknown'
  try {
    $culture = (Get-Culture).Name
  } catch {
    $culture = 'unknown'
  }

  $hasNonAsciiPath = $false
  foreach ($path in @($script:DesktopDir, $script:RepoDir)) {
    if ([regex]::IsMatch($path, '[^\x00-\x7F]')) { $hasNonAsciiPath = $true }
  }

  $codePageText = 'code page unknown'
  if ($codePage -ne '') { $codePageText = 'code page ' + $codePage }
  $version = $codePage
  if ($version -eq '') { $version = '-' }

  if ($hasNonAsciiPath -and $codePage -ne '65001') {
    # NSIS and 7z read the path through the ANSI code page.
    $detail = $codePageText + ', culture ' + $culture + ', non-ASCII checkout path'
    $fix = 'move the checkout to an ASCII-only path (e.g. C:\work\AragonAgent) or'
    $fix = $fix + ' run chcp 65001 before packaging'
    return (New-WarnResult -Name 'env' -Version $version -Detail $detail -Fix $fix)
  }

  $detail = '{0}, culture {1}, ASCII checkout path' -f $codePageText, $culture
  return (New-PassResult -Name 'env' -Version $version -Detail $detail)
}

# --- output ------------------------------------------------------------------

function Limit-DoctorText {
  param([string]$Text, [int]$Maximum)

  if ([string]::IsNullOrEmpty($Text)) { return '' }
  if ($Text.Length -le $Maximum) { return $Text }
  return $Text.Substring(0, $Maximum - 3) + '...'
}

function Get-DoctorColumnWidth {
  param([object[]]$Rows, [string]$Property, [int]$Minimum, [int]$Maximum)

  $width = $Minimum
  foreach ($row in $Rows) {
    $length = ([string]$row.$Property).Length
    if ($length -gt $width) { $width = $length }
  }
  if ($width -gt $Maximum) { return $Maximum }
  return $width
}

function Write-DoctorTable {
  param([object[]]$Checks, [switch]$OnlyProblems)

  $rows = @($Checks)
  if ($OnlyProblems) {
    $rows = @($Checks | Where-Object { $_.Status -ne $script:StatusPass })
    # -Quiet on a clean machine must not print an empty box around nothing.
    if ($rows.Count -eq 0) { return }
  }

  $nameWidth = Get-DoctorColumnWidth -Rows $rows -Property 'Name' -Minimum 4 -Maximum 21
  $statusWidth = 6
  $versionWidth = Get-DoctorColumnWidth -Rows $rows -Property 'Version' -Minimum 7 -Maximum 14
  $detailWidth = Get-DoctorColumnWidth -Rows $rows -Property 'Detail' -Minimum 6 -Maximum 60

  $rule = '+' + ('-' * ($nameWidth + 2)) + '+' + ('-' * ($statusWidth + 2)) + '+' +
    ('-' * ($versionWidth + 2)) + '+' + ('-' * ($detailWidth + 2)) + '+'
  $header = '| ' + 'NAME'.PadRight($nameWidth) + ' | ' + 'STATUS'.PadRight($statusWidth) +
    ' | ' + 'VERSION'.PadRight($versionWidth) + ' | ' + 'DETAIL'.PadRight($detailWidth) + ' |'

  Write-Output $rule
  Write-Output $header
  Write-Output $rule
  foreach ($row in $rows) {
    $name = Limit-DoctorText -Text ([string]$row.Name) -Maximum $nameWidth
    $status = ([string]$row.Status).PadRight($statusWidth)
    $version = Limit-DoctorText -Text ([string]$row.Version) -Maximum $versionWidth
    $detail = Limit-DoctorText -Text ([string]$row.Detail) -Maximum $detailWidth
    $line = '| ' + $name.PadRight($nameWidth) + ' | ' + $status + ' | ' +
      $version.PadRight($versionWidth) + ' | ' + $detail.PadRight($detailWidth) + ' |'
    Write-Output $line
  }
  Write-Output $rule
}

function Write-DoctorSummary {
  param([object[]]$Checks, [object[]]$Failed, [object[]]$Warned)

  $template = 'Doctor: {0} checks, {1} failed, {2} warnings'
  $summary = $template -f $Checks.Count, $Failed.Count, $Warned.Count
  Write-Output ''
  Write-Output $summary
  # Fix lines for failures are mandatory. Warnings that carry a remediation print
  # one too (execution policy, engine install/TUI dist, disk budget, icon, code
  # page): the brief asks for those remediations to be visible while they stay
  # non-fatal.
  foreach ($check in ($Failed + $Warned)) {
    if ([string]::IsNullOrWhiteSpace($check.Fix)) { continue }
    Write-Output ('  -> fix (' + $check.Name + '): ' + $check.Fix)
  }
}

# --- main --------------------------------------------------------------------

$roots = Resolve-DoctorRoots -RequestedDesktopRoot $DesktopRoot
$script:DesktopDir = $roots.Desktop
$script:RepoDir = $roots.Repo
Initialize-PackCommonReuse -PackDirectory $PSScriptRoot
$script:NodeMinimum = Test-DoctorNodeMinimum -DesktopDirectory $script:DesktopDir

$checks = New-Object System.Collections.ArrayList
[void]$checks.Add((Test-DoctorPowerShell))
[void]$checks.Add((Test-DoctorExecutionPolicy))
[void]$checks.Add((Test-DoctorOperatingSystem))
[void]$checks.Add((Test-DoctorNode))
[void]$checks.Add((Test-DoctorNpm))
[void]$checks.Add((Test-DoctorRepoLayout))
[void]$checks.Add((Test-DoctorDesktopNodeModules))
[void]$checks.Add((Test-DoctorElectronDependency))
[void]$checks.Add((Test-DoctorElectronBuilder))
[void]$checks.Add((Test-DoctorEngineDist))
[void]$checks.Add((Test-DoctorDiskSpace))
[void]$checks.Add((Test-DoctorWriteAccess))
[void]$checks.Add((Test-DoctorElectronRunAsNode))
[void]$checks.Add((Test-DoctorBuildIcon))
[void]$checks.Add((Test-DoctorEnvironment))

$failed = @($checks | Where-Object { $_.Status -eq $script:StatusFail })
$warned = @($checks | Where-Object { $_.Status -eq $script:StatusWarn })
$passed = @($checks | Where-Object { $_.Status -eq $script:StatusPass })
$exitCode = 0
if ($failed.Count -gt 0) { $exitCode = 1 }

if ($Json) {
  $report = [pscustomobject]@{
    tool = 'aragon-pack-doctor'
    schemaVersion = 1
    generatedAt = (Get-Date).ToString('o')
    desktopRoot = $script:DesktopDir
    repoRoot = $script:RepoDir
    summary = [pscustomobject]@{
      checks = $checks.Count
      passed = $passed.Count
      failed = $failed.Count
      warnings = $warned.Count
    }
    exitCode = $exitCode
    checks = @($checks | ForEach-Object {
        [pscustomobject]@{
          name = $_.Name
          status = $_.Status
          version = $_.Version
          detail = $_.Detail
          fix = $_.Fix
        }
      })
  }
  Write-Output ($report | ConvertTo-Json -Depth 5)
} else {
  Write-DoctorTable -Checks $checks -OnlyProblems:$Quiet
  Write-DoctorSummary -Checks $checks -Failed $failed -Warned $warned
}

exit $exitCode
