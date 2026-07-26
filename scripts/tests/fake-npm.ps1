$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$NpmArgs = @($args)

if (-not $env:ARGON_FAKE_NPM_LOG) {
  throw 'ARGON_FAKE_NPM_LOG is required'
}
if (-not $env:ARGON_FAKE_NPM_STATE) {
  throw 'ARGON_FAKE_NPM_STATE is required'
}

@{ args = @($NpmArgs) } | ConvertTo-Json -Compress | Add-Content -LiteralPath $env:ARGON_FAKE_NPM_LOG -Encoding utf8

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
  if (-not (Test-Path -LiteralPath $env:ARGON_FAKE_NPM_STATE)) {
    Write-Json $env:ARGON_FAKE_NPM_STATE ([ordered]@{ core = @(); cli = @() })
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
    if ($assignment -notmatch '^dependencies\.@argon-agent/core=(.+)$') {
      throw "Unsupported npm pkg assignment: $assignment"
    }
    $packagePath = Join-Path (Get-Location) "$workspace\package.json"
    $packageJson = Read-Json $packagePath
    $packageJson.dependencies.'@argon-agent/core' = $Matches[1]
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
        $lock.packages.$workspace.dependencies.'@argon-agent/core' = $packageJson.dependencies.'@argon-agent/core'
        $lock.packages.$workspace.bin = [ordered]@{ aragon = 'dist/cli.js' }
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
    }
    exit 0
  }
  'pack' {
    Write-Output '[{"files":[{"path":"dist/index.js"}]}]'
    exit 0
  }
  'whoami' {
    if ($env:ARGON_FAKE_NPM_UNAUTHENTICATED -eq '1') {
      [Console]::Error.WriteLine('npm error code E401')
      [Console]::Error.WriteLine('npm error 401 Unauthorized - GET https://registry.npmjs.org/-/whoami')
      exit 1
    }
    Write-Output 'release-test-user'
    exit 0
  }
  'view' {
    $specifier = $NpmArgs[1]
    if ($specifier -notmatch '^@argon-agent/(core|cli)@(.+)$') {
      throw "Unsupported npm view specifier: $specifier"
    }
    $packageKey = $Matches[1]
    $version = $Matches[2]
    $state = Read-Json $env:ARGON_FAKE_NPM_STATE
    $versions = @($state.$packageKey)
    if ($versions -notcontains $version) {
      [Console]::Error.WriteLine("npm error code E404: $specifier")
      exit 1
    }
    if ($packageKey -eq 'cli' -and $NpmArgs -contains 'bin') {
      # npm normalizes bin paths when it accepts a publish, so the registry serves
      # 'dist/cli.js' even though the source manifest declares './dist/cli.js'.
      # npm also emits notices on stderr, which the release script captures next to stdout.
      [Console]::Error.WriteLine('npm notice using registry https://registry.npmjs.org/')
      [ordered]@{
        version = $version
        bin = [ordered]@{ aragon = 'dist/cli.js' }
      } | ConvertTo-Json | Write-Output
    } else {
      Write-Output $version
    }
    exit 0
  }
  'publish' {
    $workspace = Get-Workspace $NpmArgs
    $packageKey = if ($workspace -eq 'packages/core') { 'core' } elseif ($workspace -eq 'packages/cli') { 'cli' } else { throw "Unknown workspace: $workspace" }
    $packageJson = Read-Json (Join-Path (Get-Location) "$workspace\package.json")
    $state = Read-Json $env:ARGON_FAKE_NPM_STATE
    $versions = @($state.$packageKey)
    if ($versions -contains $packageJson.version) {
      [Console]::Error.WriteLine("npm error code EPUBLISHCONFLICT: $($packageJson.version)")
      exit 1
    }
    $state.$packageKey = @($versions + $packageJson.version)
    Write-Json $env:ARGON_FAKE_NPM_STATE $state
    Write-Output "+ @argon-agent/$packageKey@$($packageJson.version)"
    exit 0
  }
  default {
    throw "Unsupported fake npm command: $($NpmArgs -join ' ')"
  }
}
