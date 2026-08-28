$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$NpmArgs = @($args)

if (-not $env:ARAGON_FAKE_NPM_LOG) {
  throw 'ARAGON_FAKE_NPM_LOG is required'
}
if (-not $env:ARAGON_FAKE_NPM_STATE) {
  throw 'ARAGON_FAKE_NPM_STATE is required'
}

@{
  args = @($NpmArgs)
  nodeOptions = $env:NODE_OPTIONS
  otpPresent = Test-Path Env:npm_config_otp
} |
  ConvertTo-Json -Compress |
  Add-Content -LiteralPath $env:ARAGON_FAKE_NPM_LOG -Encoding utf8

function Read-Json([string]$Path) {
  return Get-Content -Raw -LiteralPath $Path -Encoding utf8 | ConvertFrom-Json
}

function Write-Json([string]$Path, $Value) {
  $Value | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $Path -Encoding utf8
}

function Get-Workspace([string[]]$Arguments) {
  $workspaceIndex = [Array]::IndexOf($Arguments, '-w')
  if ($workspaceIndex -lt 0 -or $workspaceIndex + 1 -ge $Arguments.Count) {
    throw "Missing -w workspace in: $($Arguments -join ' ')"
  }
  return $Arguments[$workspaceIndex + 1]
}

function Get-NextVersion([string]$Version, [string]$Bump) {
  if ($Version -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
    throw "Unsupported test version: $Version"
  }
  $major = [int]$Matches[1]
  $minor = [int]$Matches[2]
  $patch = [int]$Matches[3]
  switch ($Bump) {
    'patch' { $patch++ }
    'minor' { $minor++; $patch = 0 }
    'major' { $major++; $minor = 0; $patch = 0 }
    default { throw "Unsupported bump: $Bump" }
  }
  return "$major.$minor.$patch"
}

function Ensure-State {
  if (-not (Test-Path -LiteralPath $env:ARAGON_FAKE_NPM_STATE)) {
    Write-Json $env:ARAGON_FAKE_NPM_STATE ([ordered]@{ core = @(); cli = @() })
  }
}

# Set-StrictMode 2.0 turns a missing property into a terminating error, and the
# deprecation keys are absent until deprecate-legacy.tests.ps1 writes them.
function Get-StateProperty($State, [string]$Name) {
  $property = $State.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }
  return $property.Value
}

function Set-StateProperty($State, [string]$Name, $Value) {
  if ($null -eq $State.PSObject.Properties[$Name]) {
    $State | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
  } else {
    $State.$Name = $Value
  }
}

if ($NpmArgs.Count -eq 0) {
  throw 'No fake npm command supplied'
}

Ensure-State
$command = $NpmArgs[0]

switch ($command) {
  'version' {
    $bump = $NpmArgs[1]
    $workspace = Get-Workspace $NpmArgs
    $packagePath = Join-Path (Get-Location) "$workspace\package.json"
    $packageJson = Read-Json $packagePath
    $packageJson.version = Get-NextVersion $packageJson.version $bump
    Write-Json $packagePath $packageJson
    Write-Output "v$($packageJson.version)"
    exit 0
  }
  'pkg' {
    if ($NpmArgs[1] -ne 'set') {
      throw "Unsupported npm pkg operation: $($NpmArgs -join ' ')"
    }
    $workspace = Get-Workspace $NpmArgs
    $assignment = $NpmArgs[2]
    if ($assignment -notmatch '^dependencies\.@aragon-agent/core=(.+)$') {
      throw "Unsupported npm pkg assignment: $assignment"
    }
    $packagePath = Join-Path (Get-Location) "$workspace\package.json"
    $packageJson = Read-Json $packagePath
    $packageJson.dependencies.'@aragon-agent/core' = $Matches[1]
    Write-Json $packagePath $packageJson
    exit 0
  }
  'install' {
    $lockPath = Join-Path (Get-Location) 'package-lock.json'
    $lock = Read-Json $lockPath
    foreach ($workspace in @('packages/core', 'packages/cli')) {
      $packageJson = Read-Json (Join-Path (Get-Location) "$workspace\package.json")
      $lock.packages.$workspace.version = $packageJson.version
      if ($workspace -eq 'packages/cli') {
        $lock.packages.$workspace.dependencies.'@aragon-agent/core' = $packageJson.dependencies.'@aragon-agent/core'
        $lock.packages.$workspace.bin = [ordered]@{ aragon = 'dist/launcher.js' }
      }
    }
    Write-Json $lockPath $lock
    exit 0
  }
  'test' {
    exit 0
  }
  'run' {
    if ($NpmArgs[1] -eq 'build' -and -not ($NpmArgs -contains '-w')) {
      $cliPackage = Read-Json (Join-Path (Get-Location) 'packages\cli\package.json')
      $distDirectory = Join-Path (Get-Location) 'packages\cli\dist'
      New-Item -ItemType Directory -Force -Path $distDirectory | Out-Null
      $cliScript = "#!/usr/bin/env node`nconsole.log('$($cliPackage.version)');`n"
      $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
      [IO.File]::WriteAllText((Join-Path $distDirectory 'cli.js'), $cliScript, $utf8WithoutBom)
      [IO.File]::WriteAllText((Join-Path $distDirectory 'launcher.js'), $cliScript, $utf8WithoutBom)
    }
    exit 0
  }
  'pack' {
    $workspace = Get-Workspace $NpmArgs
    if ($workspace -eq 'packages/core') {
      Write-Output '[{"files":[{"path":"dist/index.js"}]}]'
      exit 0
    }
    if ($workspace -ne 'packages/cli') {
      throw "Unsupported npm pack workspace: $workspace"
    }

    $files = @(
      [ordered]@{ path = 'dist/cli.js' }
      [ordered]@{ path = 'dist/launcher.js' }
    )
    if ($env:ARAGON_FAKE_NPM_OMIT_CLI_RUNTIME -ne '1') {
      $files += [ordered]@{ path = 'runtime/insecure-tls-warning.cjs' }
    }
    @([ordered]@{ files = $files }) | ConvertTo-Json -Depth 5 -Compress | Write-Output
    exit 0
  }
  'whoami' {
    if ($env:ARAGON_FAKE_NPM_UNAUTHENTICATED -eq '1') {
      [Console]::Error.WriteLine('npm error code E401')
      [Console]::Error.WriteLine('npm error 401 Unauthorized - GET https://registry.npmjs.org/-/whoami')
      exit 1
    }
    Write-Output 'release-test-user'
    exit 0
  }
  'access' {
    # Backs Assert-ScopePublishable. Without this branch the happy path falls
    # through to `default { throw }`, and because Invoke-NpmCapture runs with
    # ErrorActionPreference='Continue' the fixtures would still pass while
    # quietly asserting nothing about the no-warning side.
    if ($NpmArgs[1] -ne 'list' -or $NpmArgs[2] -ne 'packages') {
      throw "Unsupported npm access operation: $($NpmArgs -join ' ')"
    }
    if ($env:ARAGON_FAKE_NPM_SCOPE_MISSING -eq '1') {
      [Console]::Error.WriteLine('npm error code E404')
      [Console]::Error.WriteLine("npm error 404 Scope not found - GET https://registry.npmjs.org/-/org/$($NpmArgs[3])/package")
      exit 1
    }
    Write-Output '{}'
    exit 0
  }
  'view' {
    $specifier = $NpmArgs[1]

    # Legacy scope. Only deprecate-legacy.ps1 asks about it, and only to read back
    # the message it just wrote.
    if ($specifier -match '^@argon-agent/(core|cli)(?:@(.+))?$') {
      $legacyKey = $Matches[1]
      $legacyState = Read-Json $env:ARAGON_FAKE_NPM_STATE
      if ($NpmArgs -contains 'deprecated') {
        $message = Get-StateProperty $legacyState "deprecated_$legacyKey"
        if (-not [string]::IsNullOrEmpty($message)) {
          Write-Output $message
        }
        exit 0
      }
      Write-Output '0.0.0'
      exit 0
    }

    if ($specifier -notmatch '^@aragon-agent/(core|cli)(?:@(.+))?$') {
      throw "Unsupported npm view specifier: $specifier"
    }
    $packageKey = $Matches[1]
    $version = if ($Matches.ContainsKey(2)) { $Matches[2] } else { $null }
    $state = Read-Json $env:ARAGON_FAKE_NPM_STATE
    $versions = @($state.$packageKey)

    # No explicit version: report the latest published one. Backs
    # deprecate-legacy.ps1's replacement-exists precondition, whose whole job is
    # to refuse when nothing is published yet.
    if ($null -eq $version) {
      if ($versions.Count -eq 0) {
        [Console]::Error.WriteLine("npm error code E404: $specifier")
        [Console]::Error.WriteLine("npm error 404 Not Found - GET https://registry.npmjs.org/$specifier")
        exit 1
      }
      Write-Output $versions[-1]
      exit 0
    }

    if ($versions -notcontains $version) {
      [Console]::Error.WriteLine("npm error code E404: $specifier")
      exit 1
    }
    if ($packageKey -eq 'cli' -and $NpmArgs -contains 'bin') {
      # npm normalizes bin paths when it accepts a publish, so the registry serves
      # 'dist/launcher.js' even though the source manifest declares './dist/launcher.js'.
      # npm also emits notices on stderr, which the release script captures next to stdout.
      [Console]::Error.WriteLine('npm notice using registry https://registry.npmjs.org/')
      [ordered]@{
        version = $version
        bin = [ordered]@{ aragon = 'dist/launcher.js' }
      } | ConvertTo-Json | Write-Output
    } else {
      Write-Output $version
    }
    exit 0
  }
  'deprecate' {
    # Backs deprecate-legacy.tests.ps1. Records the message so the script's own
    # read-back verification has something to find.
    $specifier = $NpmArgs[1]
    if ($specifier -notmatch '^@argon-agent/(core|cli)@(.+)$') {
      throw "Unsupported npm deprecate specifier: $specifier"
    }
    $legacyKey = $Matches[1]
    $state = Read-Json $env:ARAGON_FAKE_NPM_STATE
    Set-StateProperty $state "deprecated_$legacyKey" $NpmArgs[2]
    Write-Json $env:ARAGON_FAKE_NPM_STATE $state
    exit 0
  }
  'publish' {
    if ($env:ARAGON_FAKE_NPM_REQUIRED_OTP) {
      $hasOtp = Test-Path Env:npm_config_otp
      if (-not $hasOtp -or $env:npm_config_otp -ne $env:ARAGON_FAKE_NPM_REQUIRED_OTP) {
        [Console]::Error.WriteLine('npm error code EOTP')
        [Console]::Error.WriteLine(
          'npm error This operation requires a one-time password from your authenticator.'
        )
        exit 1
      }
    }
    $workspace = Get-Workspace $NpmArgs
    $packageKey = if ($workspace -eq 'packages/core') { 'core' } elseif ($workspace -eq 'packages/cli') { 'cli' } else { throw "Unknown workspace: $workspace" }
    $packageJson = Read-Json (Join-Path (Get-Location) "$workspace\package.json")
    $state = Read-Json $env:ARAGON_FAKE_NPM_STATE
    $versions = @($state.$packageKey)
    if ($versions -contains $packageJson.version) {
      [Console]::Error.WriteLine("npm error code EPUBLISHCONFLICT: $($packageJson.version)")
      exit 1
    }
    $state.$packageKey = @($versions + $packageJson.version)
    Write-Json $env:ARAGON_FAKE_NPM_STATE $state
    Write-Output "+ @aragon-agent/$packageKey@$($packageJson.version)"
    exit 0
  }
  default {
    throw "Unsupported fake npm command: $($NpmArgs -join ' ')"
  }
}
