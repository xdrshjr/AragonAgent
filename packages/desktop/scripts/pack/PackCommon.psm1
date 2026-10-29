#requires -Version 5.1
<#
.SYNOPSIS
    Shared helpers for the AragonAgent desktop one-click packaging scripts.

.DESCRIPTION
    PackCommon.psm1 is the only place the packaging scripts talk to the environment:
    path roots, prerequisite probes, console logging (mirrored to a transcript),
    child-process execution with a truthful exit code, artifact listing, and
    size/table formatting.

    Rules this file obeys:
      - Windows PowerShell 5.1 only (no pwsh 7 syntax, no ternary, no null-coalescing).
      - Pure ASCII. Windows PowerShell 5.1 reads a BOM-less file as ANSI, so a single
        non-ASCII byte (a dash, an arrow, a smart quote) corrupts the parse.
      - Importing the module must have no side effects: no output, no files, no commands.

.NOTES
    ASCII only. Windows PowerShell 5.1. No external modules required.
#>

$script:PackLogActive = $false
$script:PackLogPath = $null
$script:PackLogFallback = $false
$script:PackLogFallbackPath = $null

# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

function ConvertTo-PackFullPath {
    <#
    .SYNOPSIS
        Turns a possibly relative path into an absolute, normalized path.
    .DESCRIPTION
        Relative input is resolved against the PowerShell current location, not the
        process working directory: the two differ as soon as a script uses Push-Location.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Path
    )

    $candidate = $Path
    if ([string]::IsNullOrWhiteSpace($candidate)) { return $null }
    if (-not [System.IO.Path]::IsPathRooted($candidate)) {
        $base = $null
        try { $base = (Get-Location).ProviderPath } catch { $base = $null }
        if ([string]::IsNullOrEmpty($base)) { $base = [System.Environment]::CurrentDirectory }
        $candidate = Join-Path -Path $base -ChildPath $candidate
    }
    $full = [System.IO.Path]::GetFullPath($candidate)
    if ($full.Length -gt 3) { $full = $full.TrimEnd('\', '/') }
    return $full
}

function Get-PackModuleDesktopRoot {
    <#
    .SYNOPSIS
        The desktop package this module belongs to: <desktop>\scripts\pack\PackCommon.psm1.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param()

    $moduleDirectory = $PSScriptRoot
    if ([string]::IsNullOrEmpty($moduleDirectory)) { return $null }
    $packDirectory = [System.IO.Path]::GetFullPath($moduleDirectory)
    $scriptsDirectory = [System.IO.Path]::GetDirectoryName($packDirectory)
    if ([string]::IsNullOrEmpty($scriptsDirectory)) { return $null }
    return [System.IO.Path]::GetDirectoryName($scriptsDirectory)
}

function Get-PackSearchRoot {
    <#
    .SYNOPSIS
        Directories whose node_modules\.bin may hold a workspace tool shim.
    #>
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter()]
        [string]$DesktopRoot
    )

    $roots = New-Object System.Collections.Generic.List[string]
    $current = $null
    try { $current = (Get-Location).ProviderPath } catch { $current = $null }
    if (-not [string]::IsNullOrEmpty($current)) { [void]$roots.Add($current) }

    $desktop = $DesktopRoot
    if ([string]::IsNullOrWhiteSpace($desktop)) { $desktop = Get-PackModuleDesktopRoot }
    if (-not [string]::IsNullOrWhiteSpace($desktop)) {
        $desktopFull = ConvertTo-PackFullPath -Path $desktop
        [void]$roots.Add($desktopFull)
        $repoRoot = [System.IO.Path]::GetFullPath((Join-Path -Path $desktopFull -ChildPath '..\..'))
        [void]$roots.Add($repoRoot)
        [void]$roots.Add((Join-Path -Path $repoRoot -ChildPath 'packages\desktop'))
    }
    return $roots.ToArray()
}

function Get-PackToolPath {
    <#
    .SYNOPSIS
        Resolves a tool name to an executable path, or $null when it is unavailable.
    .DESCRIPTION
        Only Application commands are accepted, and that detail is the point: on Windows
        `Get-Command npm` finds npm.ps1 (an ExternalScript) first, and the .ps1 shim
        corrupts an argument array passed with @splat ("npm run foo" becomes command
        "run"). Filtering on -CommandType Application yields npm.cmd, which runs with a
        truthful exit code and intact arguments.

        Tools that exist only as a workspace dependency (electron, electron-builder) are
        not on PATH at all: npm hoists them to <repo>/node_modules/.bin, so the desktop
        and repo .bin directories are searched as well.
    .PARAMETER Name
        Tool name, or a path (relative or absolute) to an executable.
    .PARAMETER SearchRoot
        Desktop package root used to find node_modules\.bin. Defaults to this module's
        package, then the current location's ancestors up to the repo root.
    .OUTPUTS
        String path, or $null.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [AllowEmptyString()]
        [string]$Name,
        [Parameter(Position = 1)]
        [string]$SearchRoot
    )

    if ([string]::IsNullOrWhiteSpace($Name)) { return $null }
    $expanded = [System.Environment]::ExpandEnvironmentVariables($Name)

    if ($expanded -like '*\*' -or $expanded -like '*/*') {
        $resolved = ConvertTo-PackFullPath -Path $expanded
        if ([string]::IsNullOrWhiteSpace($resolved)) { return $null }
        if (Test-Path -LiteralPath $resolved -PathType Leaf) { return $resolved }
        return $null
    }

    $application = $null
    try {
        $application = Get-Command -Name $expanded -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
    } catch {
        $application = $null
    }
    if ($null -ne $application) { return $application.Source }

    $roots = New-Object System.Collections.Generic.List[string]
    if (-not [string]::IsNullOrWhiteSpace($SearchRoot)) {
        [void]$roots.Add((ConvertTo-PackFullPath -Path $SearchRoot))
    }
    foreach ($root in (Get-PackSearchRoot -DesktopRoot $SearchRoot)) {
        if (-not [string]::IsNullOrWhiteSpace($root)) { [void]$roots.Add($root) }
    }
    foreach ($root in ($roots | Select-Object -Unique)) {
        $binDirectory = Join-Path -Path $root -ChildPath 'node_modules\.bin'
        if (-not (Test-Path -LiteralPath $binDirectory -PathType Container)) { continue }
        foreach ($extension in @('.cmd', '.exe', '.bat')) {
            $candidate = Join-Path -Path $binDirectory -ChildPath ($expanded + $extension)
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        }
    }
    return $null
}

function Find-PackNodeModule {
    <#
    .SYNOPSIS
        Finds an installed node module directory in the desktop or repo node_modules.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter()]
        [string]$DesktopRoot
    )

    $roots = New-Object System.Collections.Generic.List[string]
    $desktop = $DesktopRoot
    if ([string]::IsNullOrWhiteSpace($desktop)) { $desktop = Get-PackModuleDesktopRoot }
    if (-not [string]::IsNullOrWhiteSpace($desktop)) {
        $desktopFull = ConvertTo-PackFullPath -Path $desktop
        [void]$roots.Add($desktopFull)
        [void]$roots.Add([System.IO.Path]::GetFullPath((Join-Path -Path $desktopFull -ChildPath '..\..')))
    }
    foreach ($root in ($roots | Select-Object -Unique)) {
        $candidate = Join-Path -Path $root -ChildPath ('node_modules\' + $Name)
        if (Test-Path -LiteralPath $candidate -PathType Container) { return $candidate }
    }
    return $null
}

function Get-PackModuleVersion {
    <#
    .SYNOPSIS
        Reads the "version" field of an installed module's package.json, or an empty string.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [string]$ModuleDirectory
    )

    if ([string]::IsNullOrWhiteSpace($ModuleDirectory)) { return '' }
    $manifest = Join-Path -Path $ModuleDirectory -ChildPath 'package.json'
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return '' }
    try {
        $parsed = Get-Content -LiteralPath $manifest -Raw -ErrorAction Stop | ConvertFrom-Json
        if ($null -eq $parsed.version) { return '' }
        return [string]$parsed.version
    } catch {
        return ''
    }
}

function Get-PackQuietOutput {
    <#
    .SYNOPSIS
        Runs a tool and returns its combined output without printing anything.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter()]
        [string[]]$CommandArguments = @()
    )

    $exitCode = $null
    $text = ''
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $text = (& $FilePath @CommandArguments 2>&1 | Out-String)
        $exitCode = $LASTEXITCODE
    } catch {
        $text = ''
        $exitCode = $null
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    return [pscustomobject]@{ Text = [string]$text; ExitCode = $exitCode }
}

function Get-PackQuietVersion {
    <#
    .SYNOPSIS
        First non-empty output line of a version command, or an empty string.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter()]
        [string[]]$CommandArguments = @('--version'),
        [Parameter()]
        [string]$DesktopRoot
    )

    $tool = Get-PackToolPath -Name $Name -SearchRoot $DesktopRoot
    if ($null -eq $tool) { return '' }
    $output = Get-PackQuietOutput -FilePath $tool -CommandArguments $CommandArguments
    if ($null -ne $output.ExitCode -and $output.ExitCode -ne 0) { return '' }
    foreach ($line in ($output.Text -split "`r?`n")) {
        $trimmed = $line.Trim()
        if ($trimmed.Length -gt 0) { return $trimmed }
    }
    return ''
}

function Format-PackArgument {
    <#
    .SYNOPSIS
        Renders one argument for the "$ command" echo line.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [AllowNull()]
        [AllowEmptyString()]
        [string]$Value
    )

    if ($null -eq $Value) { return '""' }
    if ($Value.Length -eq 0) { return '""' }
    if ($Value -match '[\s"]') { return ('"' + ($Value -replace '"', '\"') + '"') }
    return $Value
}

function Format-PackNativeArgument {
    <#
    .SYNOPSIS
        Quotes one argument the way a native child process parses its command line.
    .DESCRIPTION
        A child splits its command line with CommandLineToArgvW (or the C runtime), so an
        argument needs double quotes as soon as it holds whitespace or a quote, and every
        embedded quote needs an odd number of backslashes in front of it. The call
        operator does not do this on Windows PowerShell 5.1: 'quo"te' reaches the child as
        a bare quote, which swallows the rest of the command line and makes the argument
        arrive as 'quote a'. This helper is used instead of that behaviour.
    .PARAMETER Value
        One argument as the caller passed it.
    .OUTPUTS
        String - the argument as it has to appear on the child's command line.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [AllowNull()]
        [AllowEmptyString()]
        [string]$Value
    )

    if ($null -eq $Value) { return '""' }
    if ($Value.Length -eq 0) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }

    $backslash = [char]'\'
    $quote = [char]'"'
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append($quote)
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq $backslash) {
            $backslashes = $backslashes + 1
            continue
        }
        if ($character -eq $quote) {
            [void]$builder.Append($backslash, (2 * $backslashes) + 1)
            [void]$builder.Append($quote)
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) {
            [void]$builder.Append($backslash, $backslashes)
            $backslashes = 0
        }
        [void]$builder.Append($character)
    }
    if ($backslashes -gt 0) { [void]$builder.Append($backslash, 2 * $backslashes) }
    [void]$builder.Append($quote)
    return $builder.ToString()
}

function Format-PackNativeArgumentList {
    <#
    .SYNOPSIS
        Joins an argument array into one command line for a native child.
    .PARAMETER ArgumentList
        Arguments in call order.
    .OUTPUTS
        String.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [AllowNull()]
        [string[]]$ArgumentList
    )

    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($argument in @($ArgumentList)) {
        if ($null -eq $argument) { continue }
        [void]$parts.Add((Format-PackNativeArgument -Value $argument))
    }
    return ($parts -join ' ')
}

function ConvertTo-PackVersionParts {
    <#
    .SYNOPSIS
        Splits a version string into numeric parts, ignoring prefixes such as "v".
    #>
    [CmdletBinding()]
    [OutputType([int[]])]
    param(
        [Parameter()]
        [AllowNull()]
        [AllowEmptyString()]
        [string]$Version
    )

    if ([string]::IsNullOrWhiteSpace($Version)) { return @() }
    $cleaned = ($Version -replace '[^0-9.]', '')
    if ([string]::IsNullOrWhiteSpace($cleaned)) { return @() }
    $parts = New-Object System.Collections.Generic.List[int]
    foreach ($token in $cleaned.Split('.')) {
        if ($token -eq '') {
            [void]$parts.Add(0)
        } else {
            [void]$parts.Add([int]$token)
        }
    }
    return $parts.ToArray()
}

function Test-PackVersionAtLeast {
    <#
    .SYNOPSIS
        True when Found is the same as or newer than Required, compared part by part.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter()]
        [AllowNull()]
        [AllowEmptyString()]
        [string]$Found,
        [Parameter()]
        [AllowNull()]
        [AllowEmptyString()]
        [string]$Required
    )

    $foundParts = @(ConvertTo-PackVersionParts -Version $Found)
    if ($foundParts.Count -eq 0) { return $false }
    $requiredParts = @(ConvertTo-PackVersionParts -Version $Required)
    if ($requiredParts.Count -eq 0) { return $true }
    $length = [Math]::Max($foundParts.Count, $requiredParts.Count)
    for ($index = 0; $index -lt $length; $index++) {
        $foundPart = 0
        if ($index -lt $foundParts.Count) { $foundPart = $foundParts[$index] }
        $requiredPart = 0
        if ($index -lt $requiredParts.Count) { $requiredPart = $requiredParts[$index] }
        if ($foundPart -gt $requiredPart) { return $true }
        if ($foundPart -lt $requiredPart) { return $false }
    }
    return $true
}

function New-PackPrerequisiteResult {
    <#
    .SYNOPSIS
        Builds the fixed prerequisite shape every probe returns.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [bool]$Ok,
        [Parameter()]
        [AllowNull()]
        [AllowEmptyString()]
        [string]$Version = '',
        [Parameter()]
        [AllowNull()]
        [AllowEmptyString()]
        [string]$Detail = ''
    )

    return [pscustomobject]@{
        Name    = [string]$Name
        Ok      = [bool]$Ok
        Version = [string]$Version
        Detail  = [string]$Detail
    }
}

function Add-PackLogFallbackLine {
    <#
    .SYNOPSIS
        Appends one line to the log file when a transcript could not be started.
    #>
    [CmdletBinding()]
    param(
        [Parameter()]
        [AllowNull()]
        [AllowEmptyString()]
        [string]$Text
    )

    if (-not $script:PackLogFallback) { return }
    if ([string]::IsNullOrWhiteSpace($script:PackLogFallbackPath)) { return }
    if ($null -eq $Text) { return }
    try {
        Add-Content -LiteralPath $script:PackLogFallbackPath -Value $Text -Encoding UTF8 -ErrorAction Stop
    } catch {
        $script:PackLogFallback = $false
    }
}

function Write-PackConsoleLine {
    <#
    .SYNOPSIS
        One colored console line, mirrored to the log (transcript or fallback file).
    #>
    [CmdletBinding()]
    param(
        [Parameter()]
        [AllowNull()]
        [AllowEmptyString()]
        [string]$Text,
        [Parameter()]
        [string]$Color = 'Gray'
    )

    if ($null -eq $Text) { $Text = '' }
    Write-Host $Text -ForegroundColor $Color
    Add-PackLogFallbackLine -Text $Text
}

function New-PackLogFileName {
    <#
    .SYNOPSIS
        Sanitizes the requested log name and adds a timestamp unless it ends in .log.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [AllowNull()]
        [AllowEmptyString()]
        [string]$Name
    )

    $safe = [string]$Name
    if ([string]::IsNullOrWhiteSpace($safe)) { $safe = 'pack' }
    foreach ($invalid in [System.IO.Path]::GetInvalidFileNameChars()) {
        $safe = $safe.Replace($invalid, '-')
    }
    $safe = $safe.Trim()
    if ($safe.Length -eq 0) { $safe = 'pack' }
    if (-not $safe.ToLowerInvariant().EndsWith('.log')) {
        $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss', [System.Globalization.CultureInfo]::InvariantCulture)
        $safe = $safe + '-' + $stamp + '.log'
    }
    return $safe
}

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

function Get-PackRoots {
    <#
    .SYNOPSIS
        Absolute roots the packaging scripts work from.
    .PARAMETER DesktopRoot
        packages/desktop. Relative input is resolved against the current location.
    .OUTPUTS
        PSCustomObject with DesktopRoot, RepoRoot, ScriptsDirectory, PackScriptsDirectory.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [string]$DesktopRoot
    )

    $desktop = ConvertTo-PackFullPath -Path $DesktopRoot
    if ([string]::IsNullOrWhiteSpace($desktop)) {
        throw 'Get-PackRoots: -DesktopRoot must not be empty.'
    }
    $repoRoot = [System.IO.Path]::GetFullPath((Join-Path -Path $desktop -ChildPath '..\..'))
    if ($repoRoot.Length -gt 3) { $repoRoot = $repoRoot.TrimEnd('\', '/') }
    $scripts = Join-Path -Path $desktop -ChildPath 'scripts'
    $pack = Join-Path -Path $scripts -ChildPath 'pack'

    return [pscustomobject]@{
        DesktopRoot          = [string]$desktop
        RepoRoot             = [string]$repoRoot
        ScriptsDirectory     = [string]([System.IO.Path]::GetFullPath($scripts))
        PackScriptsDirectory = [string]([System.IO.Path]::GetFullPath($pack))
    }
}

# ---------------------------------------------------------------------------
# Prerequisite probes
# ---------------------------------------------------------------------------

function Test-PackPowerShellPrerequisite {
    <#
    .SYNOPSIS
        Windows PowerShell 5.1 or newer; the scripts use 5.1-only syntax.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    $version = $PSVersionTable.PSVersion.ToString()
    $edition = 'Desktop'
    if ($null -ne $PSVersionTable.PSEdition) { $edition = [string]$PSVersionTable.PSEdition }
    $ok = ($PSVersionTable.PSVersion.Major -ge 5)
    $detail = 'edition ' + $edition
    if ($ok) {
        $detail = $detail + '; Windows PowerShell 5.1 is the supported host.'
    } else {
        $detail = $detail + '; Windows PowerShell 5.1 or newer is required.'
    }
    return New-PackPrerequisiteResult -Name 'powershell' -Ok $ok -Version $version -Detail $detail
}

function Test-PackNodePrerequisite {
    <#
    .SYNOPSIS
        node on PATH, with its reported version.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter()]
        [string]$DesktopRoot
    )

    $tool = Get-PackToolPath -Name 'node' -SearchRoot $DesktopRoot
    if ($null -eq $tool) {
        return New-PackPrerequisiteResult -Name 'node' -Ok $false -Detail 'node is not on PATH. Install Node.js 20 or newer.'
    }
    $version = Get-PackQuietVersion -Name 'node' -CommandArguments @('-v') -DesktopRoot $DesktopRoot
    if ($version.StartsWith('v')) { $version = $version.Substring(1) }
    if ([string]::IsNullOrWhiteSpace($version)) {
        return New-PackPrerequisiteResult -Name 'node' -Ok $false -Detail ('node was found at ' + $tool + ' but did not report a version.')
    }
    return New-PackPrerequisiteResult -Name 'node' -Ok $true -Version $version -Detail ('node at ' + $tool)
}

function Test-PackNpmPrerequisite {
    <#
    .SYNOPSIS
        npm on PATH, with its reported version.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter()]
        [string]$DesktopRoot
    )

    $tool = Get-PackToolPath -Name 'npm' -SearchRoot $DesktopRoot
    if ($null -eq $tool) {
        return New-PackPrerequisiteResult -Name 'npm' -Ok $false -Detail 'npm is not on PATH. It ships with Node.js.'
    }
    $version = Get-PackQuietVersion -Name 'npm' -CommandArguments @('--version') -DesktopRoot $DesktopRoot
    if ([string]::IsNullOrWhiteSpace($version)) {
        return New-PackPrerequisiteResult -Name 'npm' -Ok $false -Detail ('npm was found at ' + $tool + ' but did not report a version.')
    }
    return New-PackPrerequisiteResult -Name 'npm' -Ok $true -Version $version -Detail ('npm at ' + $tool)
}

function Test-PackElectronPrerequisite {
    <#
    .SYNOPSIS
        The electron devDependency, read from its package.json.
    .DESCRIPTION
        The version comes from package.json rather than from `electron --version`, which
        starts the binary: too slow for a prerequisite sweep.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter()]
        [string]$DesktopRoot
    )

    $module = Find-PackNodeModule -Name 'electron' -DesktopRoot $DesktopRoot
    if ($null -eq $module) {
        return New-PackPrerequisiteResult -Name 'electron' -Ok $false -Detail 'electron is not installed under packages/desktop or the repo root. Run npm install.'
    }
    $version = Get-PackModuleVersion -ModuleDirectory $module
    if ([string]::IsNullOrWhiteSpace($version)) {
        return New-PackPrerequisiteResult -Name 'electron' -Ok $false -Detail ('electron exists at ' + $module + ' but has no version in package.json.')
    }
    return New-PackPrerequisiteResult -Name 'electron' -Ok $true -Version $version -Detail ('installed at ' + $module)
}

function Test-PackElectronBuilderPrerequisite {
    <#
    .SYNOPSIS
        The electron-builder devDependency plus a usable CLI shim.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter()]
        [string]$DesktopRoot
    )

    $module = Find-PackNodeModule -Name 'electron-builder' -DesktopRoot $DesktopRoot
    if ($null -eq $module) {
        return New-PackPrerequisiteResult -Name 'electron-builder' -Ok $false -Detail 'electron-builder is not installed. Run npm install.'
    }
    $version = Get-PackModuleVersion -ModuleDirectory $module
    if ([string]::IsNullOrWhiteSpace($version)) {
        return New-PackPrerequisiteResult -Name 'electron-builder' -Ok $false -Detail ('electron-builder exists at ' + $module + ' but has no version in package.json.')
    }
    $shim = Get-PackToolPath -Name 'electron-builder' -SearchRoot $DesktopRoot
    if ($null -eq $shim) {
        return New-PackPrerequisiteResult -Name 'electron-builder' -Ok $false -Version $version -Detail ('version ' + $version + ' at ' + $module + ' but no node_modules/.bin/electron-builder shim was found.')
    }
    return New-PackPrerequisiteResult -Name 'electron-builder' -Ok $true -Version $version -Detail ('installed at ' + $module + '; shim ' + $shim)
}

function Test-PackNodeModulesPrerequisite {
    <#
    .SYNOPSIS
        Dependencies are installed and the two tools the packaging step needs are visible.
    .DESCRIPTION
        npm workspaces hoist devDependencies to the repo root, so packages/desktop/node_modules
        is often only a stub. Both locations are inspected.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter()]
        [string]$DesktopRoot
    )

    $desktop = $DesktopRoot
    if ([string]::IsNullOrWhiteSpace($desktop)) { $desktop = Get-PackModuleDesktopRoot }
    if ([string]::IsNullOrWhiteSpace($desktop)) {
        return New-PackPrerequisiteResult -Name 'node_modules' -Ok $false -Detail 'The desktop package root could not be determined.'
    }
    $desktopFull = ConvertTo-PackFullPath -Path $desktop
    $repoRoot = [System.IO.Path]::GetFullPath((Join-Path -Path $desktopFull -ChildPath '..\..'))

    $locations = New-Object System.Collections.Generic.List[string]
    $hasElectron = $false
    $hasBuilder = $false
    foreach ($root in @($desktopFull, $repoRoot)) {
        $modules = Join-Path -Path $root -ChildPath 'node_modules'
        if (-not (Test-Path -LiteralPath $modules -PathType Container)) { continue }
        $count = 0
        try { $count = @(Get-ChildItem -LiteralPath $modules -Force -ErrorAction SilentlyContinue).Count } catch { $count = 0 }
        [void]$locations.Add($modules + ' (' + $count + ' entries)')
        if (Test-Path -LiteralPath (Join-Path -Path $modules -ChildPath 'electron') -PathType Container) { $hasElectron = $true }
        if (Test-Path -LiteralPath (Join-Path -Path $modules -ChildPath 'electron-builder') -PathType Container) { $hasBuilder = $true }
    }

    if ($locations.Count -eq 0) {
        return New-PackPrerequisiteResult -Name 'node_modules' -Ok $false -Detail 'No node_modules found. Run npm install at the repo root.'
    }
    $detail = 'found ' + ($locations -join '; ')
    $ok = ($hasElectron -and $hasBuilder)
    if (-not $ok) {
        $missing = @()
        if (-not $hasElectron) { $missing += 'electron' }
        if (-not $hasBuilder) { $missing += 'electron-builder' }
        $detail = $detail + '; missing ' + ($missing -join ', ')
    }
    return New-PackPrerequisiteResult -Name 'node_modules' -Ok $ok -Version ([string]$locations.Count) -Detail $detail
}

function Test-PackRepoPackagesPrerequisite {
    <#
    .SYNOPSIS
        The workspace packages this checkout has to contain.
    .DESCRIPTION
        This repository has exactly two workspace packages: packages/tui and
        packages/desktop. The engine (@aragon-agent/core) and the CLI host
        (@aragon-agent/cli) are closed source and are installed from the npm
        registry as ordinary dependencies of packages/desktop, so their absence
        from packages/ is the EXPECTED shape here and never a failure. A private
        checkout that still carries packages/core and packages/cli also passes.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter()]
        [string]$DesktopRoot
    )

    $desktop = $DesktopRoot
    if ([string]::IsNullOrWhiteSpace($desktop)) { $desktop = Get-PackModuleDesktopRoot }
    if ([string]::IsNullOrWhiteSpace($desktop)) {
        return New-PackPrerequisiteResult -Name 'repo-packages' -Ok $false -Detail 'The desktop package root could not be determined.'
    }
    $desktopFull = ConvertTo-PackFullPath -Path $desktop
    $repoRoot = [System.IO.Path]::GetFullPath((Join-Path -Path $desktopFull -ChildPath '..\..'))
    $packagesDirectory = Join-Path -Path $repoRoot -ChildPath 'packages'

    if (-not (Test-Path -LiteralPath $packagesDirectory -PathType Container)) {
        return New-PackPrerequisiteResult -Name 'repo-packages' -Ok $false -Detail ('No packages directory at ' + $packagesDirectory + ': the repo root is two levels above the desktop package.')
    }
    if (-not (Test-Path -LiteralPath (Join-Path -Path $repoRoot -ChildPath 'package.json') -PathType Leaf)) {
        return New-PackPrerequisiteResult -Name 'repo-packages' -Ok $false -Detail ('No package.json at ' + $repoRoot + ': npm install has to run from the repo root.')
    }

    # Required: the two real workspace packages.
    $missing = @()
    $found = @()
    foreach ($name in @('tui', 'desktop')) {
        if (Test-Path -LiteralPath (Join-Path -Path $packagesDirectory -ChildPath $name) -PathType Container) {
            $found += $name
        } else {
            $missing += $name
        }
    }

    # Optional: the closed-source engine packages, present only in a private checkout.
    $localEngine = @()
    foreach ($name in @('core', 'cli')) {
        if (Test-Path -LiteralPath (Join-Path -Path $packagesDirectory -ChildPath $name) -PathType Container) {
            $localEngine += $name
        }
    }

    if ($missing.Count -gt 0) {
        $detail = 'found ' + ($found -join ', ') + '; missing ' + ($missing -join ', ') + ' under ' + $packagesDirectory
        return New-PackPrerequisiteResult -Name 'repo-packages' -Ok $false -Detail $detail
    }

    $engineNote = 'engine from npm registry (closed source)'
    if ($localEngine.Count -gt 0) {
        $engineNote = 'engine packages also present locally: ' + ($localEngine -join ', ')
    }
    $detail = 'found ' + ($found -join ', ') + '; ' + $engineNote
    return New-PackPrerequisiteResult -Name 'repo-packages' -Ok $true -Version ([string]$found.Count + '/' + [string]$found.Count) -Detail $detail
}

function Test-PackDiskSpacePrerequisite {
    <#
    .SYNOPSIS
        Free space on the volume that holds the packaging output.
    .DESCRIPTION
        An unsigned Electron release build plus the staged engine needs roughly 2 GB.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter()]
        [string]$DesktopRoot
    )

    $desktop = $DesktopRoot
    if ([string]::IsNullOrWhiteSpace($desktop)) { $desktop = Get-PackModuleDesktopRoot }
    if ([string]::IsNullOrWhiteSpace($desktop)) {
        return New-PackPrerequisiteResult -Name 'disk-space' -Ok $false -Detail 'The desktop package root could not be determined.'
    }
    $desktopFull = ConvertTo-PackFullPath -Path $desktop
    $rootPath = [System.IO.Path]::GetPathRoot($desktopFull)
    $requiredBytes = [long]2147483648
    try {
        $drive = New-Object -TypeName System.IO.DriveInfo -ArgumentList $rootPath
        $freeBytes = [long]$drive.AvailableFreeSpace
    } catch {
        return New-PackPrerequisiteResult -Name 'disk-space' -Ok $false -Detail ('Free space on ' + $rootPath + ' could not be read: ' + $_.Exception.Message)
    }
    $ok = ($freeBytes -ge $requiredBytes)
    $detail = (Format-PackSize -Bytes $freeBytes) + ' free on ' + $rootPath + '; 2.0 GB recommended'
    if (-not $ok) { $detail = $detail + ' - not enough for a release build' }
    return New-PackPrerequisiteResult -Name 'disk-space' -Ok $ok -Version (Format-PackSize -Bytes $freeBytes) -Detail $detail
}

function Test-PackExecutionPolicyPrerequisite {
    <#
    .SYNOPSIS
        The effective execution policy must allow running a local unsigned script.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    $effective = 'Unknown'
    try { $effective = [string](Get-ExecutionPolicy) } catch { $effective = 'Unknown' }
    $scopes = @()
    foreach ($scope in @('Process', 'CurrentUser', 'LocalMachine')) {
        $value = '?'
        try { $value = [string](Get-ExecutionPolicy -Scope $scope) } catch { $value = '?' }
        $scopes += ($scope + '=' + $value)
    }
    $ok = (@('Bypass', 'Unrestricted', 'RemoteSigned') -contains $effective)
    $detail = 'effective ' + $effective + '; ' + ($scopes -join ', ')
    if ($ok) {
        $detail = $detail + '; local unsigned scripts may run.'
    } else {
        $detail = $detail + '; run: powershell -NoProfile -ExecutionPolicy Bypass -File <script>.'
    }
    return New-PackPrerequisiteResult -Name 'execution-policy' -Ok $ok -Version $effective -Detail $detail
}

function Test-PackWriteAccessPrerequisite {
    <#
    .SYNOPSIS
        The packaging directories can actually be written.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter()]
        [string]$DesktopRoot
    )

    $desktop = $DesktopRoot
    if ([string]::IsNullOrWhiteSpace($desktop)) { $desktop = Get-PackModuleDesktopRoot }
    if ([string]::IsNullOrWhiteSpace($desktop)) {
        return New-PackPrerequisiteResult -Name 'write-access' -Ok $false -Detail 'The desktop package root could not be determined.'
    }
    $desktopFull = ConvertTo-PackFullPath -Path $desktop
    $blocked = @()
    $checked = @()
    foreach ($target in @($desktopFull, (Join-Path -Path $desktopFull -ChildPath 'scripts'))) {
        if (-not (Test-Path -LiteralPath $target -PathType Container)) { continue }
        $probe = Join-Path -Path $target -ChildPath ('.pack-write-probe-' + [guid]::NewGuid().ToString('N') + '.tmp')
        try {
            Set-Content -LiteralPath $probe -Value 'probe' -Encoding ASCII -ErrorAction Stop
            Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
            $checked += $target
        } catch {
            if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue }
            $blocked += $target
        }
    }
    if ($checked.Count -eq 0 -and $blocked.Count -eq 0) {
        return New-PackPrerequisiteResult -Name 'write-access' -Ok $false -Detail ('No writable candidate directory under ' + $desktopFull + '.')
    }
    $ok = ($blocked.Count -eq 0)
    if ($ok) {
        $detail = 'writable: ' + ($checked -join ', ')
    } else {
        $detail = 'not writable: ' + ($blocked -join ', ')
    }
    return New-PackPrerequisiteResult -Name 'write-access' -Ok $ok -Version ([string]$checked.Count) -Detail $detail
}

function Test-PackElectronRunAsNodePrerequisite {
    <#
    .SYNOPSIS
        ELECTRON_RUN_AS_NODE must be absent, otherwise Electron behaves as plain Node.
    .DESCRIPTION
        Some terminals (VS Code, Claude Code) export it. The app then dies on
        import 'electron', so a packaging run that launches the app would fail obscurely.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param()

    $value = [System.Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE')
    if ([string]::IsNullOrEmpty($value)) {
        return New-PackPrerequisiteResult -Name 'electron-run-as-node' -Ok $true -Detail 'ELECTRON_RUN_AS_NODE is not set.'
    }
    return New-PackPrerequisiteResult -Name 'electron-run-as-node' -Ok $false -Version $value -Detail ('ELECTRON_RUN_AS_NODE=' + $value + ' is set; Electron would run as plain Node. Clear it before packaging.')
}

function Test-PackPrerequisite {
    <#
    .SYNOPSIS
        Probes one prerequisite. Never throws for a missing tool.
    .PARAMETER Name
        powershell, node, npm, electron, electron-builder, node_modules, repo-packages,
        disk-space, execution-policy, write-access, electron-run-as-node (case-insensitive).
    .PARAMETER MinVersion
        Version floor such as '20.0.0'. Applied to the versioned probes only
        (powershell, node, npm, electron, electron-builder).
    .PARAMETER DesktopRoot
        packages/desktop. Defaults to the package this module lives in.
    .OUTPUTS
        PSCustomObject with Name, Ok, Version, Detail.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [AllowEmptyString()]
        [string]$Name,
        [Parameter(Position = 1)]
        [string]$MinVersion,
        [Parameter()]
        [string]$DesktopRoot
    )

    $key = ([string]$Name).Trim().ToLowerInvariant()
    $result = $null
    switch ($key) {
        'powershell' { $result = Test-PackPowerShellPrerequisite }
        'node' { $result = Test-PackNodePrerequisite -DesktopRoot $DesktopRoot }
        'npm' { $result = Test-PackNpmPrerequisite -DesktopRoot $DesktopRoot }
        'electron' { $result = Test-PackElectronPrerequisite -DesktopRoot $DesktopRoot }
        'electron-builder' { $result = Test-PackElectronBuilderPrerequisite -DesktopRoot $DesktopRoot }
        'node_modules' { $result = Test-PackNodeModulesPrerequisite -DesktopRoot $DesktopRoot }
        'repo-packages' { $result = Test-PackRepoPackagesPrerequisite -DesktopRoot $DesktopRoot }
        'disk-space' { $result = Test-PackDiskSpacePrerequisite -DesktopRoot $DesktopRoot }
        'execution-policy' { $result = Test-PackExecutionPolicyPrerequisite }
        'write-access' { $result = Test-PackWriteAccessPrerequisite -DesktopRoot $DesktopRoot }
        'electron-run-as-node' { $result = Test-PackElectronRunAsNodePrerequisite }
        default {
            $result = New-PackPrerequisiteResult -Name ([string]$Name) -Ok $false -Detail ('Unknown prerequisite "' + [string]$Name + '". Known names: powershell, node, npm, electron, electron-builder, node_modules, repo-packages, disk-space, execution-policy, write-access, electron-run-as-node.')
        }
    }

    $versioned = @('powershell', 'node', 'npm', 'electron', 'electron-builder')
    if (-not [string]::IsNullOrWhiteSpace($MinVersion) -and ($versioned -contains $key)) {
        $found = [string]$result.Version
        if ([string]::IsNullOrWhiteSpace($found)) {
            $result.Ok = $false
            $result.Detail = 'version could not be determined, requires ' + $MinVersion + ' or newer. ' + $result.Detail
        } elseif (-not (Test-PackVersionAtLeast -Found $found -Required $MinVersion)) {
            $result.Ok = $false
            $result.Detail = 'found ' + $found + ', requires ' + $MinVersion + ' or newer. ' + $result.Detail
        }
    }
    return $result
}

function Test-PackPrerequisites {
    <#
    .SYNOPSIS
        The prerequisites a packaging run always needs, in a stable order.
    .PARAMETER DesktopRoot
        packages/desktop.
    .OUTPUTS
        Array of PSCustomObject with Name, Ok, Version, Detail.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject[]])]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [string]$DesktopRoot
    )

    $names = @(
        'powershell', 'node', 'npm', 'node_modules',
        'electron', 'electron-builder', 'repo-packages', 'disk-space'
    )
    $results = New-Object System.Collections.Generic.List[object]
    foreach ($name in $names) {
        $probe = $null
        try {
            $probe = Test-PackPrerequisite -Name $name -DesktopRoot $DesktopRoot
        } catch {
            $probe = New-PackPrerequisiteResult -Name $name -Ok $false -Detail ('probe failed: ' + $_.Exception.Message)
        }
        [void]$results.Add($probe)
    }
    return $results.ToArray()
}

# ---------------------------------------------------------------------------
# Console output
# ---------------------------------------------------------------------------

function Write-PackBanner {
    <#
    .SYNOPSIS
        The boxed header of a packaging run, with host and tool versions.
    .PARAMETER Title
        Headline, for example "AragonAgent desktop pack".
    .PARAMETER Subtitle
        Optional second line.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [string]$Title,
        [Parameter(Position = 1)]
        [AllowEmptyString()]
        [string]$Subtitle
    )

    $rule = '=' * 62
    $thin = '-' * 62
    $invariant = [System.Globalization.CultureInfo]::InvariantCulture

    $powershellVersion = $PSVersionTable.PSVersion.ToString()
    $nodeTool = Get-PackToolPath -Name 'node'
    if ([string]::IsNullOrWhiteSpace($nodeTool)) { $nodeTool = '(not found)' }
    $nodeVersion = Get-PackQuietVersion -Name 'node' -CommandArguments @('-v')
    if ([string]::IsNullOrWhiteSpace($nodeVersion)) { $nodeVersion = '(not found)' }
    $npmVersion = Get-PackQuietVersion -Name 'npm' -CommandArguments @('--version')
    if ([string]::IsNullOrWhiteSpace($npmVersion)) { $npmVersion = '(not found)' }
    $osVersion = [System.Environment]::OSVersion.VersionString
    $architecture = 'x86'
    if ([System.Environment]::Is64BitOperatingSystem) { $architecture = 'x64' }

    Write-PackConsoleLine -Text $rule -Color DarkCyan
    Write-PackConsoleLine -Text ('  ' + $Title) -Color White
    if (-not [string]::IsNullOrWhiteSpace($Subtitle)) {
        Write-PackConsoleLine -Text ('  ' + $Subtitle) -Color Gray
    }
    Write-PackConsoleLine -Text $thin -Color DarkCyan
    Write-PackConsoleLine -Text ('  PowerShell : ' + $powershellVersion + ' (Desktop)') -Color Gray
    Write-PackConsoleLine -Text ('  Node       : ' + $nodeVersion + '  [' + $nodeTool + ']') -Color Gray
    Write-PackConsoleLine -Text ('  npm        : ' + $npmVersion) -Color Gray
    Write-PackConsoleLine -Text ('  OS         : ' + $osVersion + ' (' + $architecture + ')') -Color Gray
    Write-PackConsoleLine -Text ('  Started    : ' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', $invariant)) -Color Gray
    Write-PackConsoleLine -Text $rule -Color DarkCyan
}

function Write-PackStep {
    <#
    .SYNOPSIS
        Prints the start of a step and returns its start time for Write-PackStepDone.
    .PARAMETER Title
        Step name.
    .OUTPUTS
        DateTime.
    #>
    [CmdletBinding()]
    [OutputType([datetime])]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [string]$Title
    )

    $started = Get-Date
    $stamp = $started.ToString('HH:mm:ss', [System.Globalization.CultureInfo]::InvariantCulture)
    Write-PackConsoleLine -Text ('== ' + $Title + '  [' + $stamp + ']') -Color Cyan
    return $started
}

function Write-PackStepDone {
    <#
    .SYNOPSIS
        Prints the completion of a step with its elapsed time in seconds (one decimal).
    .PARAMETER Title
        Must match the Write-PackStep title.
    .PARAMETER Started
        The value Write-PackStep returned.
    .PARAMETER Seconds
        Overrides the measured elapsed time.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [string]$Title,
        [Parameter(Mandatory = $true, Position = 1)]
        [datetime]$Started,
        [Parameter()]
        [double]$Seconds = [double]::NaN
    )

    $elapsed = $Seconds
    if ([double]::IsNaN($elapsed)) {
        $elapsed = ((Get-Date) - $Started).TotalSeconds
    }
    if ($elapsed -lt 0) { $elapsed = 0 }
    $text = $elapsed.ToString('0.0', [System.Globalization.CultureInfo]::InvariantCulture)
    Write-PackConsoleLine -Text ('OK ' + $Title + ' (' + $text + 's)') -Color Green
}

function Write-PackInfo {
    <#
    .SYNOPSIS
        An informational line: "[ ok ] message".
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [AllowEmptyString()]
        [string]$Message
    )

    Write-PackConsoleLine -Text ('[ ok ] ' + $Message) -Color Green
}

function Write-PackWarn {
    <#
    .SYNOPSIS
        A warning line: "[warn] message".
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [AllowEmptyString()]
        [string]$Message
    )

    Write-PackConsoleLine -Text ('[warn] ' + $Message) -Color Yellow
}

function Write-PackFail {
    <#
    .SYNOPSIS
        A failure line: "[fail] message".
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [AllowEmptyString()]
        [string]$Message
    )

    Write-PackConsoleLine -Text ('[fail] ' + $Message) -Color Red
}

# ---------------------------------------------------------------------------
# Child processes
# ---------------------------------------------------------------------------

function New-PackProcessStartInfo {
    <#
    .SYNOPSIS
        Start info for a child whose stdout and stderr are captured as plain text.
    .DESCRIPTION
        Both streams are redirected to pipes and read as strings by
        Receive-PackProcessOutput. That is the point of not using `& exe ... 2>&1`: a
        native stderr line that comes through PowerShell's error stream is an ErrorRecord
        whose blank lines stringify to "System.Management.Automation.RemoteException".
        With pipes the console shows the bytes the tool wrote, and nothing else.

        A child started by the call operator inherits the PowerShell location as its
        working directory, so the location is used when the caller passes none.
    .PARAMETER FilePath
        Resolved executable path.
    .PARAMETER Arguments
        Argument array; quoted here, because ProcessStartInfo.Arguments is a raw string.
    .PARAMETER WorkingDirectory
        Child working directory; the current location when empty.
    .OUTPUTS
        System.Diagnostics.ProcessStartInfo.
    #>
    [CmdletBinding()]
    [OutputType([System.Diagnostics.ProcessStartInfo])]
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter()]
        [AllowNull()]
        [string[]]$Arguments,
        [Parameter()]
        [AllowNull()]
        [AllowEmptyString()]
        [string]$WorkingDirectory
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = Format-PackNativeArgumentList -ArgumentList $Arguments
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    # Same decoding the call operator applies to native output, so a tool that writes
    # non-ASCII text keeps printing exactly what it printed before.
    try { $startInfo.StandardOutputEncoding = [System.Console]::OutputEncoding } catch { }
    try { $startInfo.StandardErrorEncoding = [System.Console]::OutputEncoding } catch { }

    $directory = $WorkingDirectory
    if ([string]::IsNullOrWhiteSpace($directory)) {
        try { $directory = (Get-Location).ProviderPath } catch { $directory = $null }
    }
    if (-not [string]::IsNullOrWhiteSpace($directory)) { $startInfo.WorkingDirectory = $directory }
    return $startInfo
}

function Receive-PackProcessOutput {
    <#
    .SYNOPSIS
        Streams a started child's stdout and stderr to the console as it arrives.
    .DESCRIPTION
        One asynchronous read per stream, awaited together, so neither pipe can fill up and
        block the child, and a line is printed as soon as it exists. stdout is gray, stderr
        is dark yellow - the tool's own text in both cases, never a .NET type name.
        A blank line from the tool prints as a blank line.
    .PARAMETER Process
        A started Process with RedirectStandardOutput and RedirectStandardError.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [System.Diagnostics.Process]$Process
    )

    $outTask = $Process.StandardOutput.ReadLineAsync()
    $errTask = $Process.StandardError.ReadLineAsync()
    while ($null -ne $outTask -or $null -ne $errTask) {
        $pending = New-Object System.Collections.Generic.List[System.Threading.Tasks.Task]
        if ($null -ne $outTask) { [void]$pending.Add($outTask) }
        if ($null -ne $errTask) { [void]$pending.Add($errTask) }
        if ([System.Threading.Tasks.Task]::WaitAny($pending.ToArray(), 250) -lt 0) { continue }

        if ($null -ne $outTask -and $outTask.IsCompleted) {
            $line = $outTask.Result
            $outTask = $null
            if ($null -ne $line) {
                Write-PackConsoleLine -Text $line -Color Gray
                $outTask = $Process.StandardOutput.ReadLineAsync()
            }
            continue
        }

        $line = $errTask.Result
        $errTask = $null
        if ($null -ne $line) {
            Write-PackConsoleLine -Text $line -Color DarkYellow
            $errTask = $Process.StandardError.ReadLineAsync()
        }
    }
}

function Invoke-PackProcess {
    <#
    .SYNOPSIS
        Runs a child process with live output and a truthful exit code.
    .DESCRIPTION
        The child is started with redirected pipes and its stdout and stderr are printed
        line by line as they arrive (no buffering until exit), so they also land in an
        active transcript. Because the streams are read as strings, a tool's stderr text is
        reproduced verbatim; PowerShell's native-command error records - which render a
        blank stderr line as "System.Management.Automation.RemoteException" - are not
        involved at all.

        The tool name is resolved with Get-PackToolPath, which prefers an Application:
        npm and npx resolve to npm.cmd / npx.cmd, not to the npm.ps1 shim that mangles an
        argument array. Arguments are quoted for the child by Format-PackNativeArgument;
        this works for node, npm, npx, cmd.exe and for tools that only exist in
        node_modules/.bin (electron, electron-builder).

        -Environment is applied to this process's environment around the launch - the
        documented way to give a child a variable - and every touched variable is
        restored afterwards.
    .PARAMETER Label
        Human-readable step name used in the echo line and in errors.
    .PARAMETER FilePath
        Tool name or path (node, npm, npx, cmd.exe, electron-builder, ...).
    .PARAMETER ArgumentList
        Arguments for the child.
    .PARAMETER WorkingDirectory
        Working directory for the child. Defaults to the current location.
    .PARAMETER AllowFailure
        Return the result instead of throwing on a non-zero exit code.
    .PARAMETER Environment
        Variables to add or override for the child only.
    .OUTPUTS
        PSCustomObject with Label, ExitCode, StartedAt, Duration.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [string]$Label,
        [Parameter(Mandatory = $true, Position = 1)]
        [string]$FilePath,
        [Parameter(Mandatory = $true, Position = 2)]
        [string[]]$ArgumentList,
        [Parameter()]
        [string]$WorkingDirectory,
        [Parameter()]
        [switch]$AllowFailure,
        [Parameter()]
        [hashtable]$Environment
    )

    $resolvedWorkingDirectory = $null
    if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
        $resolvedWorkingDirectory = ConvertTo-PackFullPath -Path $WorkingDirectory
        if (-not (Test-Path -LiteralPath $resolvedWorkingDirectory -PathType Container)) {
            throw ('Invoke-PackProcess: working directory for "' + $Label + '" does not exist: ' + $resolvedWorkingDirectory)
        }
    }

    $arguments = @($ArgumentList)
    $displayArguments = (($arguments | ForEach-Object { Format-PackArgument -Value $_ }) -join ' ')
    $executable = Get-PackToolPath -Name $FilePath -SearchRoot $resolvedWorkingDirectory

    if ([string]::IsNullOrWhiteSpace($executable)) {
        Write-PackConsoleLine -Text ('$ ' + $FilePath + ' ' + $displayArguments) -Color Cyan
        Write-PackConsoleLine -Text ('[fail] ' + $Label + ': command not found: ' + $FilePath) -Color Red
        if ($AllowFailure) {
            return [pscustomobject]@{
                Label     = [string]$Label
                ExitCode  = [int]9009
                StartedAt = Get-Date
                Duration  = [timespan]::Zero
            }
        }
        throw ('Invoke-PackProcess: "' + $Label + '" could not start: command not found: ' + $FilePath)
    }

    Write-PackConsoleLine -Text ('$ ' + $executable + ' ' + $displayArguments) -Color Cyan

    $savedEnvironment = @{}
    $environmentNames = @()
    if ($null -ne $Environment) {
        foreach ($key in $Environment.Keys) {
            $variableName = [string]$key
            if ($variableName.Length -eq 0) { continue }
            $savedEnvironment[$variableName] = [System.Environment]::GetEnvironmentVariable($variableName)
            $environmentNames += $variableName
            $value = $Environment[$key]
            if ($null -eq $value) {
                [System.Environment]::SetEnvironmentVariable($variableName, $null)
            } else {
                [System.Environment]::SetEnvironmentVariable($variableName, [string]$value)
            }
        }
    }

    $startedAt = Get-Date
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $process = $null
    $processStarted = $false
    $exitCode = 0
    $launchError = $null
    try {
        $startInfo = New-PackProcessStartInfo -FilePath $executable -Arguments $arguments `
            -WorkingDirectory $resolvedWorkingDirectory
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $startInfo
        [void]$process.Start()
        $processStarted = $true
        Receive-PackProcessOutput -Process $process
        $process.WaitForExit()
        $exitCode = [int]$process.ExitCode
    } catch {
        $launchError = $_
    } finally {
        if ($null -ne $process) {
            # A reader that failed mid-stream must not leave the build running unnoticed.
            if ($processStarted -and -not $process.HasExited) {
                try { $process.Kill() } catch { }
            }
            try { $process.Dispose() } catch { }
        }
        foreach ($variableName in $environmentNames) {
            [System.Environment]::SetEnvironmentVariable($variableName, $savedEnvironment[$variableName])
        }
        $watch.Stop()
    }

    if ($null -ne $launchError) {
        Write-PackConsoleLine -Text ('[fail] ' + $Label + ': ' + $launchError.Exception.Message) -Color Red
        if (-not $AllowFailure) {
            throw ('Invoke-PackProcess: "' + $Label + '" failed to start (' + $FilePath + '): ' + $launchError.Exception.Message)
        }
        return [pscustomobject]@{
            Label     = [string]$Label
            ExitCode  = [int]9009
            StartedAt = $startedAt
            Duration  = $watch.Elapsed
        }
    }

    $numericExitCode = 0
    if ($null -ne $exitCode) { $numericExitCode = [int]$exitCode }
    $result = [pscustomobject]@{
        Label     = [string]$Label
        ExitCode  = [int]$numericExitCode
        StartedAt = $startedAt
        Duration  = $watch.Elapsed
    }
    if ($numericExitCode -ne 0) {
        if ($AllowFailure) {
            Write-PackConsoleLine -Text ('[warn] ' + $Label + ' exited with code ' + $numericExitCode) -Color Yellow
        } else {
            Write-PackConsoleLine -Text ('[fail] ' + $Label + ' exited with code ' + $numericExitCode) -Color Red
            throw ('Invoke-PackProcess: "' + $Label + '" exited with code ' + $numericExitCode + ' (' + $executable + ' ' + $displayArguments + ')')
        }
    }
    return $result
}

# ---------------------------------------------------------------------------
# Transcript log
# ---------------------------------------------------------------------------

function Start-PackLog {
    <#
    .SYNOPSIS
        Starts the console transcript and returns the full log file path.
    .DESCRIPTION
        The directory is created when missing. A second call stops the previous
        transcript first, so a script may re-open a log safely. When transcripts are
        unavailable the file is still created and appended to, and nothing throws.
    .PARAMETER LogDirectory
        Directory for the log file; created when missing.
    .PARAMETER Name
        Log name; a timestamp and .log are added when absent.
    .OUTPUTS
        String - full path of the log file.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [string]$LogDirectory,
        [Parameter(Mandatory = $true, Position = 1)]
        [string]$Name
    )

    $directory = ConvertTo-PackFullPath -Path $LogDirectory
    if ([string]::IsNullOrWhiteSpace($directory)) {
        throw 'Start-PackLog: -LogDirectory must not be empty.'
    }
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        try {
            New-Item -ItemType Directory -Path $directory -Force -ErrorAction Stop | Out-Null
        } catch {
            throw ('Start-PackLog: cannot create log directory ' + $directory + ': ' + $_.Exception.Message)
        }
    }

    $path = Join-Path -Path $directory -ChildPath (New-PackLogFileName -Name $Name)
    Stop-PackLog

    $script:PackLogPath = $path
    $script:PackLogFallbackPath = $path
    $script:PackLogActive = $false
    $script:PackLogFallback = $false

    try {
        Start-Transcript -LiteralPath $path -Force -ErrorAction Stop | Out-Null
        $script:PackLogActive = $true
    } catch {
        $script:PackLogActive = $false
        $script:PackLogFallback = $true
        Write-PackConsoleLine -Text ('[warn] transcript unavailable (' + $_.Exception.Message + '); writing the file only') -Color Yellow
    }

    if ($script:PackLogFallback) {
        $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', [System.Globalization.CultureInfo]::InvariantCulture)
        Add-PackLogFallbackLine -Text ('aragon desktop pack log - ' + $stamp)
    }
    Write-PackInfo -Message ('log file: ' + $path)
    return $path
}

function Stop-PackLog {
    <#
    .SYNOPSIS
        Stops an active transcript. No-op (and never throws) when none is active.
    #>
    [CmdletBinding()]
    param()

    try {
        if ($script:PackLogActive) {
            $previousPreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
            } finally {
                $ErrorActionPreference = $previousPreference
            }
        }
    } catch {
        # A transcript that cannot be stopped must never break the packaging run.
    } finally {
        $script:PackLogActive = $false
        $script:PackLogFallback = $false
    }
}

function Test-PackLogActive {
    <#
    .SYNOPSIS
        True while Start-PackLog's transcript is running.
    .OUTPUTS
        Boolean.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param()

    return [bool]$script:PackLogActive
}

# ---------------------------------------------------------------------------
# Artifacts and formatting
# ---------------------------------------------------------------------------

function Get-PackArtifactKind {
    <#
    .SYNOPSIS
        Classifies one top-level entry of the release directory.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true)]
        [System.IO.FileSystemInfo]$Item
    )

    if ($Item.PSIsContainer) { return 'folder' }
    $extension = [System.IO.Path]::GetExtension($Item.Name).ToLowerInvariant()
    switch ($extension) {
        '.exe' { return 'installer' }
        '.msi' { return 'installer' }
        '.dmg' { return 'installer' }
        '.appimage' { return 'installer' }
        '.deb' { return 'installer' }
        '.zip' { return 'installer' }
        '.blockmap' { return 'metadata' }
        '.yml' { return 'metadata' }
        '.yaml' { return 'metadata' }
        '.json' { return 'metadata' }
        default { return 'other' }
    }
}

function Get-PackArtifactRank {
    <#
    .SYNOPSIS
        Sort group: installers, then folders, then metadata, then everything else.
    #>
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Kind
    )

    switch ($Kind) {
        'installer' { return 0 }
        'folder' { return 1 }
        'metadata' { return 2 }
        default { return 3 }
    }
}

function Test-PackReparsePoint {
    <#
    .SYNOPSIS
        True when a path is a junction or symlink, or cannot be inspected at all.
    .DESCRIPTION
        Measure-PackTree must not follow a link: a release folder can hold a junction to a
        build cache or back to its own parent, and following one either double counts the
        bytes or never terminates. An entry whose attributes cannot be read is treated the
        same way, because the artifact table is a report, not a verification step.
    .PARAMETER Path
        Directory to inspect.
    .OUTPUTS
        Boolean.
    #>
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    try {
        $attributes = [System.IO.File]::GetAttributes($Path)
        return (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
    } catch {
        return $true
    }
}

function Measure-PackTree {
    <#
    .SYNOPSIS
        Total byte length and file count of everything below one directory.
    .DESCRIPTION
        One depth-first pass over the tree: every directory is enumerated once, files are
        measured while it is visited, and subdirectories are pushed on a stack instead of
        recursing, so a deep output folder cannot exhaust the call stack.

        It never throws. A directory the process may not list, a file that disappears
        between enumeration and measurement, and a reparse point (junction, symlink) are
        all skipped: a release folder that contains a junction to a build cache must not
        double count it or loop forever, and the artifact table is a report, not a
        verification step.
    .PARAMETER Path
        Directory to measure.
    .OUTPUTS
        PSCustomObject with SizeBytes [long] and FileCount [int].
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $totalBytes = [long]0
    $fileCount = [int]0
    $pending = New-Object System.Collections.Generic.Stack[string]
    $pending.Push($Path)

    while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        try {
            foreach ($file in [System.IO.Directory]::EnumerateFiles($current)) {
                try {
                    $totalBytes += ([System.IO.FileInfo]$file).Length
                    $fileCount = $fileCount + 1
                } catch {
                    # Locked or vanished entry: it is not part of the report.
                }
            }
        } catch {
            # Unreadable directory: report what was readable.
        }
        try {
            foreach ($child in [System.IO.Directory]::EnumerateDirectories($current)) {
                if (Test-PackReparsePoint -Path $child) { continue }
                $pending.Push($child)
            }
        } catch {
            # Unreadable directory: report what was readable.
        }
    }

    return [pscustomobject]@{
        SizeBytes = [long]$totalBytes
        FileCount = [int]$fileCount
    }
}

function Get-PackArtifacts {
    <#
    .SYNOPSIS
        The top-level contents of a release directory, in presentation order.
    .DESCRIPTION
        Only the top level is enumerated, so an installer inside win-unpacked is never
        reported as an installer. Installers sort first, then folders, then metadata,
        then other files; newest first inside each group.

        A folder entry carries the recursive size and file count of its contents, measured
        in one pass by Measure-PackTree, because reporting a release folder as "0 B" makes
        an unpacked build look like an empty one.
    .PARAMETER ReleaseDirectory
        release or release-e2e.
    .PARAMETER Max
        Maximum number of entries; -1 (or omitted) returns them all.
    .OUTPUTS
        Array of PSCustomObject with Name, FullName, SizeBytes, SizeText, Kind,
        LastWriteTime, FileCount. A file counts as one file; a folder counts everything
        below it. A missing or empty directory emits nothing, so `$items.Count` is 0 and
        `@(Get-PackArtifacts ...).Count` is 0; nothing throws.
    #>
    [CmdletBinding()]
    [OutputType([pscustomobject[]])]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [string]$ReleaseDirectory,
        [Parameter(Position = 1)]
        [int]$Max = -1
    )

    $rows = New-Object System.Collections.Generic.List[object]
    $directory = $null
    try { $directory = ConvertTo-PackFullPath -Path $ReleaseDirectory } catch { $directory = $null }
    if ([string]::IsNullOrWhiteSpace($directory)) { return $rows.ToArray() }
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { return $rows.ToArray() }

    $entries = @()
    try {
        $entries = @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)
    } catch {
        return $rows.ToArray()
    }

    foreach ($entry in $entries) {
        $kind = Get-PackArtifactKind -Item $entry
        $size = [long]0
        $fileCount = [int]0
        if ($entry.PSIsContainer) {
            $measured = Measure-PackTree -Path ([string]$entry.FullName)
            $size = [long]$measured.SizeBytes
            $fileCount = [int]$measured.FileCount
        } else {
            try { $size = [long]$entry.Length } catch { $size = [long]0 }
            $fileCount = 1
        }
        [void]$rows.Add([pscustomobject]@{
            Name          = [string]$entry.Name
            FullName      = [string]$entry.FullName
            SizeBytes     = [long]$size
            SizeText      = [string](Format-PackSize -Bytes $size)
            Kind          = [string]$kind
            LastWriteTime = [datetime]$entry.LastWriteTime
            FileCount     = [int]$fileCount
            Rank          = [int](Get-PackArtifactRank -Kind $kind)
        })
    }

    $ordered = @($rows | Sort-Object -Property @{ Expression = { $_.Rank } },
        @{ Expression = { $_.LastWriteTime }; Descending = $true },
        @{ Expression = { $_.Name }; Descending = $false })

    $result = New-Object System.Collections.Generic.List[object]
    foreach ($row in $ordered) {
        [void]$result.Add([pscustomobject]@{
            Name          = [string]$row.Name
            FullName      = [string]$row.FullName
            SizeBytes     = [long]$row.SizeBytes
            SizeText      = [string]$row.SizeText
            Kind          = [string]$row.Kind
            LastWriteTime = [datetime]$row.LastWriteTime
            FileCount     = [int]$row.FileCount
        })
    }
    if ($Max -gt 0 -and $result.Count -gt $Max) {
        $result = $result.GetRange(0, $Max)
    }
    return $result.ToArray()
}

function Format-PackSize {
    <#
    .SYNOPSIS
        Human-readable byte size: '0 B', '512 B', '1.5 KB', '128.4 MB', '1.10 GB'.
    .DESCRIPTION
        Invariant culture throughout: a comma decimal separator would be unreadable in
        the packaging log, and a French or German host would otherwise produce one.
    .PARAMETER Bytes
        Size in bytes.
    .OUTPUTS
        String.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [long]$Bytes
    )

    $invariant = [System.Globalization.CultureInfo]::InvariantCulture
    $value = [double]$Bytes
    $sign = ''
    if ($value -lt 0) {
        $sign = '-'
        $value = -$value
    }
    if ($value -lt 1024) {
        return ($sign + ([long]$value).ToString($invariant) + ' B')
    }
    if ($value -lt 1048576) {
        return ($sign + ($value / 1024).ToString('0.0', $invariant) + ' KB')
    }
    if ($value -lt 1073741824) {
        return ($sign + ($value / 1048576).ToString('0.0', $invariant) + ' MB')
    }
    if ($value -lt 1099511627776) {
        return ($sign + ($value / 1073741824).ToString('0.00', $invariant) + ' GB')
    }
    return ($sign + ($value / 1099511627776).ToString('0.00', $invariant) + ' TB')
}

function ConvertTo-PackCellText {
    <#
    .SYNOPSIS
        One table cell as display text, with a width cap and an ASCII ellipsis.
    #>
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter()]
        [AllowNull()]
        [object]$Value,
        [Parameter()]
        [int]$MaximumWidth = 36
    )

    $text = ''
    if ($null -ne $Value) {
        if ($Value -is [datetime]) {
            $text = ([datetime]$Value).ToString('yyyy-MM-dd HH:mm:ss', [System.Globalization.CultureInfo]::InvariantCulture)
        } elseif ($Value -is [double] -or $Value -is [decimal] -or $Value -is [single]) {
            $text = ([double]$Value).ToString('0.##', [System.Globalization.CultureInfo]::InvariantCulture)
        } else {
            $text = [string]$Value
        }
    }
    $text = $text -replace "`r", ' '
    $text = $text -replace "`n", ' '
    if ($MaximumWidth -gt 2 -and $text.Length -gt $MaximumWidth) {
        $text = $text.Substring(0, $MaximumWidth - 2) + '..'
    }
    return $text
}

function Get-PackTableWidth {
    <#
    .SYNOPSIS
        Column widths for Write-PackTable, shrunk until the table fits the console.
    #>
    [CmdletBinding()]
    [OutputType([int[]])]
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Columns,
        [Parameter(Mandatory = $true)]
        [object[]]$Cells,
        [Parameter(Mandatory = $true)]
        [int]$AvailableWidth
    )

    $widths = New-Object System.Collections.Generic.List[int]
    for ($index = 0; $index -lt $Columns.Count; $index++) {
        $width = [Math]::Max(3, $Columns[$index].Length)
        foreach ($row in $Cells) {
            $cellLength = ([string]$row[$index]).Length
            if ($cellLength -gt $width) { $width = $cellLength }
        }
        [void]$widths.Add($width)
    }

    $total = 3 * $widths.Count + 1
    foreach ($width in $widths) { $total += $width }
    while ($total -gt $AvailableWidth -and $widths.Count -gt 0) {
        $widestIndex = 0
        for ($index = 1; $index -lt $widths.Count; $index++) {
            if ($widths[$index] -gt $widths[$widestIndex]) { $widestIndex = $index }
        }
        if ($widths[$widestIndex] -le 8) { break }
        $widths[$widestIndex] = $widths[$widestIndex] - 1
        $total = 3 * $widths.Count + 1
        foreach ($width in $widths) { $total += $width }
    }
    return $widths.ToArray()
}

function Write-PackTable {
    <#
    .SYNOPSIS
        Aligned ASCII table for prerequisite and artifact listings.
    .DESCRIPTION
        Columns come from the first row when -Columns is omitted. Cells are printed via
        Write-Host so they reach an active transcript, and are truncated with '..' when
        the table would be wider than the console.
    .PARAMETER Rows
        Objects with the properties named in -Columns.
    .PARAMETER Columns
        Property names to print, in order.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [AllowNull()]
        [AllowEmptyCollection()]
        [object[]]$Rows,
        [Parameter(Position = 1)]
        [AllowNull()]
        [AllowEmptyCollection()]
        [string[]]$Columns
    )

    if ($null -eq $Rows -or $Rows.Count -eq 0) { return }

    $columnNames = @()
    if ($null -ne $Columns) { $columnNames = @($Columns) }
    if ($columnNames.Count -eq 0) {
        if ($Rows[0] -is [string]) {
            # Plain strings are rows too. A property walk would find only the string's
            # own Length, so the text itself becomes the single column, and a caller
            # never has to wrap its lines in an object first.
            $columnNames = @('Value')
        } else {
            foreach ($property in $Rows[0].PSObject.Properties) {
                if ($property.Name -eq 'Rank') { continue }
                $columnNames += $property.Name
            }
        }
    }
    if ($columnNames.Count -eq 0) { return }

    $cells = New-Object System.Collections.Generic.List[object]
    foreach ($row in $Rows) {
        $values = New-Object System.Collections.Generic.List[string]
        foreach ($column in $columnNames) {
            $value = $null
            if ($row -is [string]) {
                $value = $row
            } else {
                $property = $null
                try { $property = $row.PSObject.Properties[$column] } catch { $property = $null }
                if ($null -ne $property) { $value = $property.Value }
            }
            [void]$values.Add([string](ConvertTo-PackCellText -Value $value -MaximumWidth 200))
        }
        [void]$cells.Add($values.ToArray())
    }

    $availableWidth = 78
    try {
        $hostWidth = $Host.UI.RawUI.WindowSize.Width
        if ($hostWidth -gt 20) { $availableWidth = $hostWidth - 1 }
    } catch {
        $availableWidth = 78
    }
    if ($availableWidth -lt 24) { $availableWidth = 24 }

    $widths = Get-PackTableWidth -Columns $columnNames -Cells $cells.ToArray() -AvailableWidth $availableWidth

    $trimmed = New-Object System.Collections.Generic.List[object]
    foreach ($values in $cells) {
        $trimmedRow = New-Object System.Collections.Generic.List[string]
        for ($index = 0; $index -lt $columnNames.Count; $index++) {
            [void]$trimmedRow.Add([string](ConvertTo-PackCellText -Value $values[$index] -MaximumWidth $widths[$index]))
        }
        [void]$trimmed.Add($trimmedRow.ToArray())
    }

    $header = @()
    $separators = @()
    for ($index = 0; $index -lt $columnNames.Count; $index++) {
        $header += $columnNames[$index].PadRight($widths[$index])
        $separators += ('-' * $widths[$index])
    }

    Write-PackConsoleLine -Text ('  ' + ($header -join ' | ')) -Color White
    Write-PackConsoleLine -Text ('  ' + ($separators -join '-+-')) -Color DarkGray
    foreach ($values in $trimmed) {
        $line = @()
        for ($index = 0; $index -lt $columnNames.Count; $index++) {
            $line += ([string]$values[$index]).PadRight($widths[$index])
        }
        Write-PackConsoleLine -Text ('  ' + ($line -join ' | ')) -Color Gray
    }
}

Export-ModuleMember -Function @(
    'Get-PackRoots',
    'Get-PackToolPath',
    'Test-PackPrerequisite',
    'Test-PackPrerequisites',
    'Write-PackBanner',
    'Write-PackStep',
    'Write-PackStepDone',
    'Write-PackInfo',
    'Write-PackWarn',
    'Write-PackFail',
    'Invoke-PackProcess',
    'Start-PackLog',
    'Stop-PackLog',
    'Test-PackLogActive',
    'Get-PackArtifacts',
    'Format-PackSize',
    'Write-PackTable'
)
