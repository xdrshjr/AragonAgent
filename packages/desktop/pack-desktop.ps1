#Requires -Version 5.1
<#
.SYNOPSIS
  One-click packaging for the AragonAgent desktop app (Electron).

.DESCRIPTION
  This script ORCHESTRATES the packaging pipeline that already exists; it never reimplements a
  build step. Each heavy step is one of these existing node scripts, run through the shared
  process runner:

    repo root : npm run build -w packages/tui
    desktop   : node scripts/dist.mjs --flavor=<f> --platform=<p> [--dir] --output=<dir>
    desktop   : node scripts/verify-bundle.mjs --app <unpacked> --flavor <f> --platform <p>

  The TUI has to be built first: the desktop imports @aragon-agent/tui/model/*, which resolves
  through the TUI export map to packages/tui/dist/*.d.ts, and a clean checkout has no dist yet.
  The engine itself (@aragon-agent/core, @aragon-agent/cli) is closed source - scripts/stage.mjs
  installs it from the npm registry - so nothing in this repo has to compile it.

  Logging, the live process runner, prerequisite probes and artifact listing live in
  scripts\pack\PackCommon.psm1 (same folder as this script).

.PARAMETER Flavor
  release (default, what users install) or e2e (the packaged build the harness may drive).

.PARAMETER Platform
  win, mac or linux. Defaults to the host platform. A platform other than the host is refused with
  exit code 2: electron-builder cannot cross-build mac/linux from Windows in this repo, and
  scripts/ci-desktop.mjs enforces the same rule.

.PARAMETER Output
  Output directory for electron-builder. Defaults to release (release flavor) or release-e2e (e2e).

.PARAMETER Dir
  Build the unpacked app only, no installer. This is the fast path (~ every other step skipped by
  electron-builder).

.PARAMETER Clean
  Remove dist, build-staging and the output directory first.

.PARAMETER SkipVerify
  Do not run scripts/verify-bundle.mjs.

.PARAMETER SkipEngineBuild
  Do not run "npm run build -w packages/tui" before packing. packages/tui/dist is then used exactly as
  it sits on disk, and the desktop build fails with TS2307 when there is none.

.PARAMETER Doctor
  Run scripts\pack\Invoke-PackDoctor.ps1 and exit with its exit code.

.PARAMETER NoOpen
  Do not open the output folder when the run finishes.

.PARAMETER NoPause
  Do not pause before exiting, even in an interactive console.

.PARAMETER Help
  Print usage and exit 0. Works even when PackCommon.psm1 is missing.

.OUTPUTS
  Exit code 0 = success, 1 = failure, 2 = bad usage. The log file path is printed on both paths.
#>
[CmdletBinding()]
param(
    [string]$Flavor = 'release',
    [string]$Platform = '',
    [string]$Output = '',
    [switch]$Dir,
    [switch]$Clean,
    [switch]$SkipVerify,
    [switch]$SkipEngineBuild,
    [switch]$Doctor,
    [switch]$NoOpen,
    [switch]$NoPause,
    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------------------------------
# Help text. Kept first so -Help never needs the module.
# ---------------------------------------------------------------------------------------------------
function Show-PackUsage {
    Write-Host ''
    Write-Host 'pack-desktop.ps1 - build the AragonAgent desktop app (installer, or unpacked app with -Dir)'
    Write-Host ''
    Write-Host 'USAGE'
    Write-Host '  .\pack-desktop.ps1'
    Write-Host '  .\pack-desktop.ps1 [-Flavor <release|e2e>] [-Platform <win|mac|linux>] [-Output <dir>]'
    Write-Host '                     [-Dir] [-Clean] [-SkipVerify] [-SkipEngineBuild] [-Doctor]'
    Write-Host '                     [-NoOpen] [-NoPause] [-Help]'
    Write-Host ''
    Write-Host 'SWITCHES'
    Write-Host '  -Flavor <release|e2e>  Build flavor. release = what users install (default).'
    Write-Host '                         e2e = the packaged build the E2E harness may drive.'
    Write-Host '  -Platform <name>       win | mac | linux. Default: the host platform. A different'
    Write-Host '                         platform is refused (exit 2): electron-builder cannot'
    Write-Host '                         cross-build mac/linux from Windows in this repo.'
    Write-Host '  -Output <dir>          electron-builder output directory. Relative paths resolve'
    Write-Host '                         against packages\desktop. Default: release | release-e2e.'
    Write-Host '  -Dir                   Unpacked app only, no installer. The fast path.'
    Write-Host '  -Clean                 Remove dist, build-staging and the output dir first.'
    Write-Host '  -SkipVerify            Skip scripts/verify-bundle.mjs (flavor + fuse check).'
    Write-Host '  -SkipEngineBuild       Skip the TUI build (npm run build -w packages/tui); use dist as is.'
    Write-Host '  -Doctor                Run scripts\pack\Invoke-PackDoctor.ps1 and exit with its code.'
    Write-Host '  -NoOpen                Do not open the output folder in Explorer at the end.'
    Write-Host '  -NoPause               Do not wait for Enter at the end (CI never pauses anyway).'
    Write-Host '  -Help                  Print this text and exit 0.'
    Write-Host ''
    Write-Host 'EXAMPLES'
    Write-Host '  .\pack-desktop.ps1                          release installer for the host platform'
    Write-Host '  .\pack-desktop.ps1 -Dir                     fast unpacked build, no installer'
    Write-Host '  .\pack-desktop.ps1 -Clean -Output build\out  clean build into a custom folder'
    Write-Host '  .\pack-desktop.ps1 -Doctor                  print a diagnostics report'
    Write-Host ''
    Write-Host 'EXIT CODES'
    Write-Host '  0 success   1 failure   2 bad usage'
    Write-Host ''
    Write-Host 'Logs are written to packages\desktop\pack-logs\pack-<timestamp>.log; the path is printed'
    Write-Host 'at the end of every run.'
    Write-Host ''
}

# ---------------------------------------------------------------------------------------------------
# Small pure helpers.
# ---------------------------------------------------------------------------------------------------
function Get-PackHostPlatform {
    if ((Test-Path -Path variable:IsWindows) -and $IsWindows) { return 'win' }
    if ((Test-Path -Path variable:IsMacOS) -and $IsMacOS) { return 'mac' }
    if ((Test-Path -Path variable:IsLinux) -and $IsLinux) { return 'linux' }
    if ($env:OS -eq 'Windows_NT') { return 'win' }
    $osPlatform = [System.Environment]::OSVersion.Platform
    if ($osPlatform -eq [System.PlatformID]::Win32NT) { return 'win' }
    if ($osPlatform -eq [System.PlatformID]::MacOSX) { return 'mac' }
    return 'linux'
}

function Get-PackNormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $segments = [char[]]@('\', '/')
    return ([System.IO.Path]::GetFullPath($Path)).TrimEnd($segments)
}

function Format-PackCommandLine {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @()
    )
    $parts = New-Object System.Collections.Generic.List[string]
    $parts.Add($FilePath)
    foreach ($argument in $ArgumentList) {
        $text = ''
        if ($null -ne $argument) { $text = [string]$argument }
        if ($text -eq '') { $parts.Add('""') }
        elseif ($text -match '[\s"]') { $parts.Add('"' + $text + '"') }
        else { $parts.Add($text) }
    }
    return ($parts -join ' ')
}

function Format-PackNameCell {
    param(
        [string]$Text = '',
        [int]$Width = 48
    )
    if ($Text.Length -le $Width) { return $Text.PadRight($Width) }
    return ($Text.Substring(0, $Width - 2) + '..')
}

function Resolve-PackOutputDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$DesktopRoot,
        [Parameter(Mandatory = $true)][string]$Flavor,
        [string]$Output = ''
    )
    if ([string]::IsNullOrWhiteSpace($Output)) {
        $defaultName = 'release'
        if ($Flavor -eq 'e2e') { $defaultName = 'release-e2e' }
        return (Join-Path -Path $DesktopRoot -ChildPath $defaultName)
    }
    $candidate = $Output.Trim()
    if ([System.IO.Path]::IsPathRooted($candidate)) { return ([System.IO.Path]::GetFullPath($candidate)) }
    return ([System.IO.Path]::GetFullPath((Join-Path -Path $DesktopRoot -ChildPath $candidate)))
}

# Same rules as scripts/ci-desktop.mjs (packagedApp), for a chosen output directory.
function Get-PackagedAppDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$OutputDirectory,
        [Parameter(Mandatory = $true)][string]$Platform
    )
    if ($Platform -eq 'win') { return (Join-Path -Path $OutputDirectory -ChildPath 'win-unpacked') }
    if ($Platform -eq 'mac') {
        $armDirectory = Join-Path -Path $OutputDirectory -ChildPath 'mac-arm64'
        if (Test-Path -LiteralPath $armDirectory) { return $armDirectory }
        return (Join-Path -Path $OutputDirectory -ChildPath 'mac')
    }
    return (Join-Path -Path $OutputDirectory -ChildPath 'linux-unpacked')
}

# Same rules as scripts/ci-desktop.mjs (exeOf).
function Get-PackExecutablePath {
    param(
        [Parameter(Mandatory = $true)][string]$AppDirectory,
        [Parameter(Mandatory = $true)][string]$Platform
    )
    if ($Platform -eq 'win') { return (Join-Path -Path $AppDirectory -ChildPath 'AragonAgent.exe') }
    if ($Platform -eq 'mac') {
        $bundle = Join-Path -Path $AppDirectory -ChildPath 'AragonAgent.app'
        return (Join-Path -Path $bundle -ChildPath 'Contents\MacOS\AragonAgent')
    }
    return (Join-Path -Path $AppDirectory -ChildPath 'aragonagent')
}

function Test-PackInteractiveConsole {
    # A CI runner must never hang: no TTY, redirected stdin or a service context means no pause.
    if (-not [Environment]::UserInteractive) { return $false }
    try {
        if ([Console]::IsInputRedirected) { return $false }
    } catch {
        return $false
    }
    return $true
}

function Invoke-PackInteractivePause {
    Write-Host ''
    Write-Host 'Press Enter to finish ...'
    try { $null = Read-Host } catch { }
}

# ---------------------------------------------------------------------------------------------------
# Per-prerequisite remediation, so a missing tool comes with the exact next command.
# ---------------------------------------------------------------------------------------------------
function Get-PackRemediation {
    param(
        [string]$Name = '',
        [string]$RepoRoot = ''
    )
    $key = $Name.ToLowerInvariant()
    if ($key -like '*electron-builder*') {
        $hint = 'run: npm install   (in {0}) - electron-builder is a devDependency of packages\desktop'
        return ($hint -f $RepoRoot)
    }
    if ($key -like '*electron*') {
        return ('run: npm install   (in {0}) - Electron is a devDependency of packages\desktop' -f $RepoRoot)
    }
    if ($key -like '*node_modules*') {
        return ('run: npm install   (in {0})' -f $RepoRoot)
    }
    if ($key -like '*node*') {
        return 'install Node.js 22 LTS from https://nodejs.org/, then reopen this window'
    }
    if ($key -like '*npm*') {
        return 'npm ships with Node.js - reinstall Node.js 22 LTS if "npm --version" fails'
    }
    if ($key -like '*package*') {
        return ('run this script from a full checkout: {0} must contain packages\tui and packages\desktop (the engine comes from the npm registry)' -f $RepoRoot)
    }
    if ($key -like '*powershell*') {
        return 'this script needs Windows PowerShell 5.1 - run it from a normal PowerShell or cmd window'
    }
    return 're-run this script with -Doctor for a detailed report (also see the pack-logs folder)'
}

function Assert-PackPrerequisites {
    param(
        [object[]]$Prerequisites = @(),
        [string]$RepoRoot = ''
    )
    $blocking = @()
    foreach ($item in $Prerequisites) {
        $name = [string]$item.Name
        if ($item.Ok) {
            Write-PackInfo -Message ('  [OK]   {0,-18} {1}' -f $name, ([string]$item.Version))
        } elseif ($name -like '*disk*') {
            # Low disk space is a warning: the build may still fit, and failing here is unhelpful.
            Write-PackWarn -Message ('  [WARN] {0,-18} {1}' -f $name, ([string]$item.Detail))
        } else {
            Write-PackFail -Message ('  [FAIL] {0,-18} {1}' -f $name, ([string]$item.Detail))
            $blocking += $item
        }
    }
    if ($blocking.Count -eq 0) { return }
    foreach ($item in $blocking) {
        $fix = Get-PackRemediation -Name ([string]$item.Name) -RepoRoot $RepoRoot
        Write-PackFail -Message ('  fix: ' + $fix)
    }
    throw 'missing prerequisites (see the "fix:" lines above)'
}

# ---------------------------------------------------------------------------------------------------
# Step runner: prints the exact command line before the step, the duration after it.
# ---------------------------------------------------------------------------------------------------
function Invoke-PackBuildStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [switch]$AllowFailure
    )
    $started = Write-PackStep -Title $Title
    Write-PackInfo -Message ('  cwd: ' + $WorkingDirectory)
    $commandLine = Format-PackCommandLine -FilePath $FilePath -ArgumentList $ArgumentList
    Write-PackInfo -Message ('  $ ' + $commandLine)
    $caught = $null
    $processResult = $null
    try {
        $processResult = Invoke-PackProcess -Label $Title -FilePath $FilePath `
            -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -AllowFailure:$AllowFailure
    } catch {
        $caught = $_
    }
    $seconds = Get-PackStepSeconds -Started $started -ProcessResult $processResult
    Write-PackStepDone -Title $Title -Started $started -Seconds $seconds
    if ($null -ne $caught) { throw $caught }
    return $processResult
}

function Get-PackStepSeconds {
    # Prefer the duration the shared runner measured; fall back to this script's own clock so a runner
    # that also leaves objects on the pipeline cannot break the timing line.
    param(
        [Parameter(Mandatory = $true)][datetime]$Started,
        [object]$ProcessResult = $null
    )
    $last = $null
    if ($null -ne $ProcessResult) {
        $emitted = @($ProcessResult)
        if ($emitted.Count -gt 0) { $last = $emitted[$emitted.Count - 1] }
    }
    if ($null -ne $last -and $null -ne $last.PSObject.Properties['Duration']) {
        $duration = $last.Duration
        if ($null -ne $duration) { return ([double]$duration.TotalSeconds) }
    }
    return ((Get-Date) - $Started).TotalSeconds
}

function Invoke-PackClean {
    param(
        [Parameter(Mandatory = $true)][string]$DesktopRoot,
        [Parameter(Mandatory = $true)][string]$OutputDirectory
    )
    $started = Write-PackStep -Title 'clean'
    $desktopPath = Get-PackNormalizedPath -Path $DesktopRoot
    $targets = @((Join-Path -Path $DesktopRoot -ChildPath 'dist'),
                 (Join-Path -Path $DesktopRoot -ChildPath 'build-staging'),
                 $OutputDirectory)
    foreach ($target in $targets) {
        if (-not (Test-Path -LiteralPath $target)) {
            Write-PackInfo -Message ('  already absent: ' + $target)
            continue
        }
        $resolved = Get-PackNormalizedPath -Path $target
        # Never delete the package folder itself (or a drive root) because of a mistyped -Output.
        if ($resolved -eq $desktopPath -or $resolved.Length -le 3) {
            Write-PackWarn -Message ('  refusing to delete {0}' -f $resolved)
            Write-PackWarn -Message '  (it is the package folder or a drive root)'
            continue
        }
        Write-PackInfo -Message ('  removing ' + $resolved)
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
    Write-PackStepDone -Title 'clean' -Started $started -Seconds ((Get-Date) - $started).TotalSeconds
}

# ---------------------------------------------------------------------------------------------------
# Artifact report.
#
# The rows of the artifact table are data, not per-step results: they print plainly, never through
# Write-PackInfo ("[ ok ]") or Write-PackWarn ("[warn]"), which stay reserved for step results.
# Write-Host still reaches the log, because the log is a console transcript.
#
# The module may not sum a folder recursively and may not report FileCount. A folder that is 0 B
# while visibly holding files is therefore shown as "(size not reported by module)" and never
# contributes to a total: a wrong "0 B" reads as "the build produced nothing".
# ---------------------------------------------------------------------------------------------------
function Write-PackPlainLine {
    param([string]$Text = '')
    Write-Host $Text
}

function Get-PackArtifactProperty {
    # StrictMode throws on a missing property and the module contract grows: read defensively.
    param(
        [Parameter(Mandatory = $true)][object]$Artifact,
        [Parameter(Mandatory = $true)][string]$Name
    )
    if ($null -eq $Artifact) { return $null }
    $property = $null
    try { $property = $Artifact.PSObject.Properties[$Name] } catch { $property = $null }
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-PackFolderFileCount {
    # Fallback only: the module reports FileCount once it counts folders recursively.
    param([string]$Path = '')
    if ($Path -eq '') { return 0 }
    try {
        return [int]@(Get-ChildItem -LiteralPath $Path -Recurse -Force -File `
            -ErrorAction SilentlyContinue).Count
    } catch {
        return 0
    }
}

function Get-PackArtifactRow {
    param([Parameter(Mandatory = $true)][object]$Artifact)
    $name = [string](Get-PackArtifactProperty -Artifact $Artifact -Name 'Name')
    $fullName = [string](Get-PackArtifactProperty -Artifact $Artifact -Name 'FullName')
    $kind = [string](Get-PackArtifactProperty -Artifact $Artifact -Name 'Kind')
    $sizeBytes = [long]0
    $rawSize = Get-PackArtifactProperty -Artifact $Artifact -Name 'SizeBytes'
    if ($null -ne $rawSize) { $sizeBytes = [long]$rawSize }
    $fileCount = $null
    $rawCount = Get-PackArtifactProperty -Artifact $Artifact -Name 'FileCount'
    if ($null -ne $rawCount) { $fileCount = [int]$rawCount }

    $isFolder = ($kind -eq 'folder')
    if (-not $isFolder -and $fullName -ne '') {
        if (Test-Path -LiteralPath $fullName -PathType Container) {
            $isFolder = $true
            $kind = 'folder'
        }
    }
    $sizeReported = $true
    if ($isFolder) {
        if ($null -eq $fileCount) { $fileCount = Get-PackFolderFileCount -Path $fullName }
        # 0 B next to a non-empty folder means the module summed nothing, not that nothing is there.
        if ($sizeBytes -le 0 -and $fileCount -gt 0) { $sizeReported = $false }
    }
    return [pscustomobject]@{
        Name         = [string]$name
        FullName     = [string]$fullName
        Kind         = [string]$kind
        SizeBytes    = [long]$sizeBytes
        SizeReported = [bool]$sizeReported
        FileCount    = $fileCount
    }
}

function Format-PackArtifactSizeCell {
    param([Parameter(Mandatory = $true)][object]$Row)
    if ($Row.Kind -eq 'folder' -and -not $Row.SizeReported) {
        return '(size not reported by module)'
    }
    return [string](Format-PackSize -Bytes ([long]$Row.SizeBytes))
}

function Write-PackArtifactTable {
    param([object[]]$Rows = @())
    $nameWidth = 40
    $kindWidth = 10
    $sizeWidth = 30
    $fileWidth = 6
    $joiner = ' | '

    $cells = @((Format-PackNameCell -Text 'NAME' -Width $nameWidth),
        (Format-PackNameCell -Text 'KIND' -Width $kindWidth),
        ('SIZE'.PadLeft($sizeWidth)), ('FILES'.PadLeft($fileWidth)))
    Write-PackPlainLine -Text ('  ' + ($cells -join $joiner))
    $cells = @(('-' * $nameWidth), ('-' * $kindWidth), ('-' * $sizeWidth), ('-' * $fileWidth))
    Write-PackPlainLine -Text ('  ' + ($cells -join '-+-'))

    foreach ($row in $Rows) {
        $nameCell = Format-PackNameCell -Text ([string]$row.Name) -Width $nameWidth
        $kindCell = Format-PackNameCell -Text ([string]$row.Kind) -Width $kindWidth
        $sizeCell = (Format-PackArtifactSizeCell -Row $row).PadLeft($sizeWidth)
        # FILES is a folder quantity only; a plain file is one file by definition.
        $filesCell = '-'
        if ($row.Kind -eq 'folder' -and $null -ne $row.FileCount) {
            $filesCell = [string]([int]$row.FileCount)
        }
        $cells = @($nameCell, $kindCell, $sizeCell, $filesCell.PadLeft($fileWidth))
        Write-PackPlainLine -Text ('  ' + ($cells -join $joiner))
    }
}

function Write-PackArtifactSummary {
    param([object[]]$Rows = @())
    $order = @('installer', 'folder', 'metadata', 'other')
    $labels = @{
        installer = @{ One = 'installer'; Many = 'installers'; Always = $true }
        folder    = @{ One = 'folder'; Many = 'folders'; Always = $false }
        metadata  = @{ One = 'metadata file'; Many = 'metadata files'; Always = $false }
        other     = @{ One = 'other file'; Many = 'other files'; Always = $false }
    }
    $totals = @{}
    foreach ($kind in $order) {
        $totals[$kind] = @{ Count = 0; Bytes = [long]0; Known = $true }
    }
    foreach ($row in $Rows) {
        $kind = [string]$row.Kind
        if (-not $totals.ContainsKey($kind)) { $kind = 'other' }
        $totals[$kind].Count = [int]$totals[$kind].Count + 1
        $totals[$kind].Bytes = [long]$totals[$kind].Bytes + [long]$row.SizeBytes
        if ($kind -eq 'folder' -and -not $row.SizeReported) { $totals[$kind].Known = $false }
    }

    # No grand total across kinds: an unpacked app folder and an installer are different things to
    # ship, and one sum of both is a number nobody can use.
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($kind in $order) {
        $entry = $totals[$kind]
        $label = $labels[$kind]
        if ($entry.Count -eq 0 -and -not $label.Always) { continue }
        if ($entry.Count -eq 0) {
            [void]$parts.Add(('0 {0}' -f $label.Many))
            continue
        }
        $sizeText = 'size not reported by module'
        if ($entry.Known) { $sizeText = [string](Format-PackSize -Bytes ([long]$entry.Bytes)) }
        $name = $label.Many
        if ($entry.Count -eq 1) { $name = $label.One }
        [void]$parts.Add(('{0} {1} ({2})' -f $entry.Count, $name, $sizeText))
    }
    $entries = '{0} entries' -f $Rows.Count
    if ($Rows.Count -eq 1) { $entries = '1 entry' }
    Write-PackPlainLine -Text ('  summary: ' + ($parts -join ', ') + ' - ' + $entries)
}

function Test-PackInstallerExtension {
    param([string]$Path = '')
    $installerKinds = @('.exe', '.dmg', '.zip', '.appimage', '.deb')
    if ($Path -eq '') { return $false }
    $extension = [System.IO.Path]::GetExtension($Path)
    if ($extension -eq '') { return $false }
    return ($installerKinds -contains $extension.ToLowerInvariant())
}

function Write-PackInstallerPaths {
    param([object[]]$Rows = @())
    $installers = @()
    foreach ($row in $Rows) {
        # Kind comes from the module; the extension test keeps this working on an older module.
        $isInstaller = ([string]$row.Kind -eq 'installer')
        if (-not $isInstaller) { $isInstaller = Test-PackInstallerExtension -Path ([string]$row.FullName) }
        if ($isInstaller) { $installers += $row }
    }
    if ($installers.Count -eq 0) {
        Write-PackInfo -Message '  installers: none (a -Dir build produces the unpacked app folder only)'
        return
    }
    Write-PackInfo -Message '  installers (copy-paste the full path):'
    foreach ($installer in $installers) {
        Write-PackInfo -Message ('    ' + [string]$installer.FullName)
    }
}

function Write-PackArtifactReport {
    param(
        [Parameter(Mandatory = $true)][string]$OutputDirectory,
        [string]$UnpackedAppDirectory = '',
        [switch]$UnpackedOnly
    )
    if (-not (Test-Path -LiteralPath $OutputDirectory)) {
        Write-PackWarn -Message ('  output directory not found: ' + $OutputDirectory)
        return
    }
    $artifacts = @(Get-PackArtifacts -ReleaseDirectory $OutputDirectory -Max 60)
    if ($artifacts.Count -eq 0) {
        if ($UnpackedOnly -and $UnpackedAppDirectory -ne '') {
            Write-PackInfo -Message '  this -Dir build ships the unpacked app folder, not an installer:'
            Write-PackInfo -Message ('    ' + $UnpackedAppDirectory)
        } else {
            Write-PackWarn -Message ('  no files found in ' + $OutputDirectory)
        }
        return
    }
    $rows = @()
    foreach ($artifact in $artifacts) {
        $rows += (Get-PackArtifactRow -Artifact $artifact)
    }
    Write-PackArtifactTable -Rows $rows
    Write-PackArtifactSummary -Rows $rows
    Write-PackInstallerPaths -Rows $rows
}

function Open-PackOutputFolder {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Platform
    )
    if (-not (Test-Path -LiteralPath $Path)) { return }
    try {
        if ($Platform -eq 'win') { $null = Start-Process -FilePath $Path }
        elseif ($Platform -eq 'mac') { $null = Start-Process -FilePath 'open' -ArgumentList @($Path) }
        else { $null = Start-Process -FilePath 'xdg-open' -ArgumentList @($Path) }
    } catch {
        Write-PackWarn -Message ('  could not open {0}: {1}' -f $Path, $_.Exception.Message)
    }
}

# ---------------------------------------------------------------------------------------------------
# -Help first: must work with no module present, so it is printed before the import.
# ---------------------------------------------------------------------------------------------------
if ($Help) {
    Show-PackUsage
    exit 0
}

# ---------------------------------------------------------------------------------------------------
# Usage checks that need no module: exit 2 for bad usage.
# ---------------------------------------------------------------------------------------------------
$scriptStart = Get-Date
$exitCode = 0
$failure = $false
$logPath = ''
$desktopRoot = $PSScriptRoot
$hostPlatform = Get-PackHostPlatform
$nodePlatforms = @{ win = 'win32'; mac = 'darwin'; linux = 'linux' }

if ([string]::IsNullOrWhiteSpace($Flavor)) { $Flavor = 'release' }
if ([string]::IsNullOrWhiteSpace($Platform)) { $Platform = $hostPlatform }
$Flavor = $Flavor.Trim().ToLowerInvariant()
$Platform = $Platform.Trim().ToLowerInvariant()

if (@('release', 'e2e') -notcontains $Flavor) {
    $message = "pack-desktop: unknown -Flavor '{0}' (expected release or e2e)" -f $Flavor
    Write-Host $message -ForegroundColor Red
    Write-Host 'pack-desktop: run this script with -Help for usage.'
    exit 2
}
if (@('win', 'mac', 'linux') -notcontains $Platform) {
    $message = "pack-desktop: unknown -Platform '{0}' (expected win, mac or linux)" -f $Platform
    Write-Host $message -ForegroundColor Red
    Write-Host 'pack-desktop: run this script with -Help for usage.'
    exit 2
}
if ($Platform -ne $hostPlatform) {
    Write-Host ("pack-desktop: cannot build {0} on {1}." -f $Platform, $hostPlatform) -ForegroundColor Red
    $message = 'pack-desktop: electron-builder cannot cross-build {0} from {1} in this repo;'
    Write-Host ($message -f $Platform, $hostPlatform)
    Write-Host '              scripts/ci-desktop.mjs enforces the same rule in its "package" mode'
    Write-Host '              ("cannot build <platform> on <host>").'
    Write-Host ("pack-desktop: run the {0} build on a {0} host (or in CI) instead." -f $Platform)
    exit 2
}

# ---------------------------------------------------------------------------------------------------
# Load the shared module. Everything below this point needs it.
# ---------------------------------------------------------------------------------------------------
$modulePath = Join-Path -Path $desktopRoot -ChildPath 'scripts\pack\PackCommon.psm1'
if (-not (Test-Path -LiteralPath $modulePath)) {
    Write-Host ''
    $message = 'pack-desktop: missing scripts\pack\PackCommon.psm1 (looked for {0})'
    Write-Host ($message -f $modulePath) -ForegroundColor Red
    Write-Host 'pack-desktop: this module ships with the desktop package - restore the folder, e.g.'
    Write-Host '              git checkout -- packages/desktop/scripts/pack'
    Write-Host '              then run this script again. (-Help works without it.)'
    Write-Host ''
    exit 1
}
try {
    Import-Module -Name $modulePath -Force -ErrorAction Stop
} catch {
    Write-Host ("pack-desktop: could not import {0}" -f $modulePath) -ForegroundColor Red
    Write-Host ('              {0}' -f $_.Exception.Message) -ForegroundColor Red
    Write-Host 'pack-desktop: restore packages\desktop\scripts\pack from a clean checkout and retry.'
    exit 1
}

$requiredCommands = @('Get-PackRoots', 'Test-PackPrerequisites', 'Write-PackBanner', 'Write-PackStep',
    'Write-PackStepDone', 'Write-PackInfo', 'Write-PackWarn', 'Write-PackFail', 'Invoke-PackProcess',
    'Start-PackLog', 'Stop-PackLog', 'Get-PackArtifacts', 'Format-PackSize')
$missingCommands = @($requiredCommands | Where-Object {
    -not (Get-Command -Name $_ -ErrorAction SilentlyContinue)
})
if ($missingCommands.Count -gt 0) {
    $message = 'pack-desktop: scripts\pack\PackCommon.psm1 does not export: {0}'
    Write-Host ($message -f ($missingCommands -join ', ')) -ForegroundColor Red
    Write-Host 'pack-desktop: the module is incomplete - restore packages\desktop\scripts\pack'
    Write-Host '              from a clean checkout.'
    exit 1
}

$roots = Get-PackRoots -DesktopRoot $desktopRoot

# A bad -Output is bad usage (exit 2), not a crash: GetFullPath throws on illegal characters.
try {
    $outputDir = Resolve-PackOutputDirectory -DesktopRoot $roots.DesktopRoot -Flavor $Flavor -Output $Output
} catch {
    Write-Host ("pack-desktop: invalid -Output '{0}'" -f $Output) -ForegroundColor Red
    Write-Host ('pack-desktop: {0}' -f $_.Exception.Message) -ForegroundColor Red
    Write-Host 'pack-desktop: pass a plain directory path, e.g. -Output build\out (no quotes inside it).'
    exit 2
}

# ---------------------------------------------------------------------------------------------------
# -Doctor: hand over to the diagnostics script and exit with its code.
# ---------------------------------------------------------------------------------------------------
if ($Doctor) {
    $doctorPath = Join-Path -Path $roots.PackScriptsDirectory -ChildPath 'Invoke-PackDoctor.ps1'
    if (-not (Test-Path -LiteralPath $doctorPath)) {
        $message = 'pack-desktop: -Doctor needs {0}, which does not exist.'
        Write-Host ($message -f $doctorPath) -ForegroundColor Red
        Write-Host 'pack-desktop: restore packages\desktop\scripts\pack from a clean checkout and retry.'
        exit 1
    }
    Write-PackBanner -Title 'AragonAgent Desktop - diagnostics' -Subtitle $doctorPath
    & $doctorPath
    $doctorExit = 0
    $hasExitCode = (Test-Path -Path variable:LASTEXITCODE) -and ($null -ne $LASTEXITCODE)
    if ($hasExitCode) { $doctorExit = [int]$LASTEXITCODE }
    exit $doctorExit
}

# ---------------------------------------------------------------------------------------------------
# Banner, then the log file (pack-logs\pack-<timestamp>.log).
# ---------------------------------------------------------------------------------------------------
$modeText = 'installer (NSIS / dmg / AppImage / deb)'
if ($Dir) { $modeText = 'unpacked app only (-Dir, the fast path)' }
$bannerSubtitle = 'flavor {0} | platform {1} | {2}' -f $Flavor, $Platform, $modeText
Write-PackBanner -Title 'AragonAgent Desktop - pack' -Subtitle $bannerSubtitle

$logDirectory = Join-Path -Path $roots.DesktopRoot -ChildPath 'pack-logs'
try {
    if (-not (Test-Path -LiteralPath $logDirectory)) {
        $null = New-Item -ItemType Directory -Path $logDirectory -Force -ErrorAction Stop
    }
    $logName = 'pack-{0:yyyyMMdd-HHmmss}.log' -f (Get-Date)
    $logPath = [string](Start-PackLog -LogDirectory $logDirectory -Name $logName)
} catch {
    Write-PackWarn -Message ('could not start a log file in {0}: {1}' -f $logDirectory, $_.Exception.Message)
}
if ($logPath -ne '') { Write-PackInfo -Message ('log: ' + $logPath) }
Write-PackInfo -Message ('output: ' + $outputDir)
if ($outputDir -match '\s') {
    Write-PackWarn -Message 'the output path contains a space - dist.mjs joins npm/npx arguments'
    Write-PackWarn -Message '  unquoted on Windows, so prefer a space-free -Output'
}

# ---------------------------------------------------------------------------------------------------
# The run.
# ---------------------------------------------------------------------------------------------------
try {
    $gateStarted = Write-PackStep -Title 'prerequisites'
    $prerequisites = @(Test-PackPrerequisites -DesktopRoot $roots.DesktopRoot)
    Assert-PackPrerequisites -Prerequisites $prerequisites -RepoRoot $roots.RepoRoot
    $gateSeconds = ((Get-Date) - $gateStarted).TotalSeconds
    Write-PackStepDone -Title 'prerequisites' -Started $gateStarted -Seconds $gateSeconds

    if ($Clean) {
        Invoke-PackClean -DesktopRoot $roots.DesktopRoot -OutputDirectory $outputDir
    }

    if ($SkipEngineBuild) {
        Write-PackWarn -Message 'TUI build skipped (-SkipEngineBuild):'
        Write-PackWarn -Message '  packages\tui\dist is used exactly as it sits on disk'
        Write-PackWarn -Message '  rebuild it by hand with: npm run build -w packages/tui (in the repo root)'
    } else {
        $tuiDirectory = Join-Path -Path $roots.RepoRoot -ChildPath 'packages\tui'
        $tuiManifest = Join-Path -Path $tuiDirectory -ChildPath 'package.json'
        $tuiTypings = Join-Path -Path $tuiDirectory -ChildPath 'dist\index.d.ts'
        if (-not (Test-Path -LiteralPath $tuiManifest)) {
            Write-PackWarn -Message ('packages\tui not found at {0} - skipping the TUI build' -f $tuiDirectory)
            Write-PackWarn -Message '  the desktop imports @aragon-agent/tui/model/* ; dist.mjs will fail with TS2307'
        } elseif (Test-Path -LiteralPath $tuiTypings) {
            Write-PackInfo -Message 'packages\tui\dist is present - the TUI does not need rebuilding'
            Write-PackInfo -Message '  (use -Clean, or npm run build -w packages/tui, to refresh it first)'
        } else {
            Write-PackInfo -Message 'packages\tui\dist is missing and the desktop build imports its types'
            $null = Invoke-PackBuildStep -Title 'build TUI (npm run build -w packages/tui)' -FilePath 'npm' `
                -ArgumentList @('run', 'build', '-w', 'packages/tui') `
                -WorkingDirectory $roots.RepoRoot
        }
    }

    $distArguments = @('scripts/dist.mjs', ('--flavor=' + $Flavor), ('--platform=' + $Platform))
    if ($Dir) { $distArguments += '--dir' }
    $distArguments += ('--output=' + $outputDir)
    $null = Invoke-PackBuildStep -Title 'dist (build, stage, electron-builder)' -FilePath 'node' `
        -ArgumentList $distArguments -WorkingDirectory $roots.DesktopRoot

    $appDir = Get-PackagedAppDirectory -OutputDirectory $outputDir -Platform $Platform
    if ($SkipVerify) {
        Write-PackWarn -Message 'verify-bundle skipped (-SkipVerify): the baked flavor and the fuse'
        Write-PackWarn -Message '  wire in the executable were NOT checked'
    } else {
        $verifyArguments = @('scripts/verify-bundle.mjs')
        if (Test-Path -LiteralPath $appDir) {
            $verifyArguments += @('--app', $appDir)
        } else {
            $message = 'unpacked app not found at {0} - verifying the staged engine only'
            Write-PackWarn -Message ($message -f $appDir)
        }
        $verifyArguments += @('--flavor', $Flavor, '--platform', $nodePlatforms[$Platform])
        $null = Invoke-PackBuildStep -Title 'verify-bundle (flavor + fuses)' -FilePath 'node' `
            -ArgumentList $verifyArguments -WorkingDirectory $roots.DesktopRoot
    }

    $reportStarted = Write-PackStep -Title 'artifacts'
    Write-PackArtifactReport -OutputDirectory $outputDir -UnpackedAppDirectory $appDir -UnpackedOnly:$Dir
    Write-PackInfo -Message ('  output folder: ' + $outputDir)
    if (Test-Path -LiteralPath $appDir) { Write-PackInfo -Message ('  unpacked app:  ' + $appDir) }
    $exePath = Get-PackExecutablePath -AppDirectory $appDir -Platform $Platform
    if (Test-Path -LiteralPath $exePath) {
        Write-PackInfo -Message ('  executable:    ' + $exePath)
        Write-PackInfo -Message ('  optional smoke test (not run here): "{0}" --smoke' -f $exePath)
    }
    $reportSeconds = ((Get-Date) - $reportStarted).TotalSeconds
    Write-PackStepDone -Title 'artifacts' -Started $reportStarted -Seconds $reportSeconds

    $elapsed = (Get-Date) - $scriptStart
    Write-PackInfo -Message ''
    Write-PackInfo -Message ('DONE in {0:n1}s (every step exit 0)' -f $elapsed.TotalSeconds)
    if ($logPath -ne '') { Write-PackInfo -Message ('log: ' + $logPath) }

    if (-not $NoOpen) { Open-PackOutputFolder -Path $outputDir -Platform $Platform }
} catch {
    $failure = $true
    $exitCode = 1
    $elapsedSeconds = ((Get-Date) - $scriptStart).TotalSeconds
    Write-PackFail -Message ('FAILED after {0:n1}s: {1}' -f $elapsedSeconds, $_.Exception.Message)
    if ($logPath -ne '') { Write-PackInfo -Message ('log: ' + $logPath) }
} finally {
    if ($logPath -ne '') {
        try { Stop-PackLog } catch { }
    }
}

# ---------------------------------------------------------------------------------------------------
# After the log is closed: plain console output, then an interactive-only pause.
# ---------------------------------------------------------------------------------------------------
if ($failure) {
    Write-Host ''
    Write-Host 'pack-desktop: the build did NOT complete.' -ForegroundColor Red
    Write-Host '  nothing in the output folder above should be shipped.' -ForegroundColor Red
    if ($logPath -ne '') { Write-Host ('  full log: ' + $logPath) }
    Write-Host '  next: run pack-desktop.cmd -Doctor for a diagnostics report.'
}
if (-not $NoPause -and (Test-PackInteractiveConsole)) { Invoke-PackInteractivePause }

exit $exitCode
