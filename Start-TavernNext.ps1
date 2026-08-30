<#
.SYNOPSIS
Validates and starts the TavernNext local development stack.

.DESCRIPTION
Checks the required Node.js version, npm, workspace dependencies, and listening
ports before starting the API and Vite servers together. The browser opens only
after the API health endpoint responds.

.PARAMETER DataDir
TavernNext data directory. Relative paths are resolved from the repository root.

.PARAMETER ApiHost
API bind address. Defaults to the local-only address 127.0.0.1.

.PARAMETER ApiPort
API listen port. Defaults to 4312.

.PARAMETER WebHost
Vite bind address. Defaults to the local-only address 127.0.0.1.

.PARAMETER WebPort
Vite listen port. Defaults to 5173.

.PARAMETER InstallDependencies
Runs npm install before startup even when required workspace commands exist.

.PARAMETER NoBrowser
Does not open the web UI automatically.

.PARAMETER CheckOnly
Runs all read-only startup checks without installing dependencies or starting services.

.PARAMETER Help
Shows the startup options and examples without running any checks.

.PARAMETER AllowUnsupportedNode
Allows diagnostics with an older Node.js version. Normal use should update Node.js instead.

.EXAMPLE
.\Start-TavernNext.ps1

.EXAMPLE
.\Start-TavernNext.ps1 -DataDir 'D:\TavernNext-data' -ApiPort 4412 -WebPort 5273
#>
[CmdletBinding(PositionalBinding = $false)]
param(
  [Alias('DataDirectory')]
  [string] $DataDir,

  [ValidateNotNullOrEmpty()]
  [string] $ApiHost = '127.0.0.1',

  [ValidateRange(1, 65535)]
  [int] $ApiPort = 4312,

  [ValidateNotNullOrEmpty()]
  [string] $WebHost = '127.0.0.1',

  [ValidateRange(1, 65535)]
  [int] $WebPort = 5173,

  [switch] $InstallDependencies,
  [switch] $NoBrowser,
  [switch] $CheckOnly,
  [switch] $Help,
  [switch] $AllowUnsupportedNode
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$projectRoot = $PSScriptRoot
$manifestPath = Join-Path $projectRoot 'package.json'

function Write-Step {
  param([Parameter(Mandatory = $true)][string] $Message)
  Write-Host "[TavernNext] $Message" -ForegroundColor Cyan
}

function Show-Usage {
  Write-Host @'
Usage:
  .\Start-TavernNext.cmd [options]

Options:
  -DataDir <path>            Data directory; relative paths use the repository root.
  -ApiHost <address>         API bind address (default: 127.0.0.1).
  -ApiPort <port>            API port (default: 4312).
  -WebHost <address>         Web bind address (default: 127.0.0.1).
  -WebPort <port>            Web port (default: 5173).
  -InstallDependencies       Run npm install before startup.
  -NoBrowser                 Do not open the web UI automatically.
  -CheckOnly                 Validate without installing or starting services.
  -AllowUnsupportedNode      Diagnostic override; updating Node.js is recommended.
  -Help                      Show this help.

Examples:
  .\Start-TavernNext.cmd
  .\Start-TavernNext.cmd -DataDir 'D:\TavernNext-data' -NoBrowser
  .\Start-TavernNext.cmd -ApiPort 4412 -WebPort 5273
'@
}

function Stop-Startup {
  param([Parameter(Mandatory = $true)][string] $Message)
  throw "TavernNext startup check failed: $Message"
}

function Resolve-Executable {
  param([Parameter(Mandatory = $true)][string[]] $Names)

  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) {
      return $command.Source
    }
  }
  return $null
}

function Get-MinimumNodeVersion {
  param([Parameter(Mandatory = $true)][object] $Manifest)

  $engine = [string] $Manifest.engines.node
  if ($engine -notmatch '^\s*>=\s*(\d+)\.(\d+)\.(\d+)\s*$') {
    Stop-Startup "Unsupported Node.js engine declaration '$engine' in package.json."
  }
  return [version]::new([int] $Matches[1], [int] $Matches[2], [int] $Matches[3])
}

function Test-PortAvailable {
  param(
    [Parameter(Mandatory = $true)][string] $Address,
    [Parameter(Mandatory = $true)][int] $Port
  )

  if ($Address -eq 'localhost') {
    $ipAddress = [System.Net.IPAddress]::Loopback
  } elseif ($Address -eq '0.0.0.0') {
    $ipAddress = [System.Net.IPAddress]::Any
  } elseif ($Address -eq '::') {
    $ipAddress = [System.Net.IPAddress]::IPv6Any
  } else {
    $parsedAddress = $null
    if ([System.Net.IPAddress]::TryParse($Address, [ref] $parsedAddress)) {
      $ipAddress = $parsedAddress
    } else {
      try {
        $ipAddress = [System.Net.Dns]::GetHostAddresses($Address) | Select-Object -First 1
      } catch {
        Stop-Startup "Host '$Address' cannot be resolved."
      }
    }
  }

  $listener = [System.Net.Sockets.TcpListener]::new($ipAddress, $Port)
  try {
    $listener.Server.ExclusiveAddressUse = $true
    $listener.Start()
    return $true
  } catch [System.Net.Sockets.SocketException] {
    return $false
  } finally {
    $listener.Stop()
  }
}

function Get-BrowserHost {
  param([Parameter(Mandatory = $true)][string] $BindHost)

  if ($BindHost -eq '0.0.0.0') { return '127.0.0.1' }
  if ($BindHost -eq '::') { return '[::1]' }
  if ($BindHost.Contains(':') -and -not $BindHost.StartsWith('[')) { return "[$BindHost]" }
  return $BindHost
}

function Invoke-Npm {
  param(
    [Parameter(Mandatory = $true)][string] $NpmPath,
    [Parameter(Mandatory = $true)][string[]] $Arguments
  )

  & $NpmPath @Arguments
  if ($LASTEXITCODE -ne 0) {
    Stop-Startup "npm $($Arguments -join ' ') exited with code $LASTEXITCODE."
  }
}

try {
  if ($Help) {
    Show-Usage
    exit 0
  }

  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    Stop-Startup "package.json was not found beside the startup script."
  }

  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $minimumNodeVersion = Get-MinimumNodeVersion -Manifest $manifest
  $nodePath = Resolve-Executable -Names @('node.exe', 'node')
  # Prefer npm.ps1 so Ctrl+C is not routed through an extra npm.cmd batch layer.
  $npmPath = Resolve-Executable -Names @('npm.ps1', 'npm.cmd', 'npm')

  if ($null -eq $nodePath) {
    Stop-Startup "Node.js is not installed or is not available on PATH. Install Node.js $minimumNodeVersion or newer."
  }
  if ($null -eq $npmPath) {
    Stop-Startup 'npm is not installed or is not available on PATH.'
  }

  $nodeVersionText = (& $nodePath --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $nodeVersionText -notmatch '^v(\d+\.\d+\.\d+)') {
    Stop-Startup "Unable to determine the installed Node.js version from '$nodePath'."
  }
  $nodeVersion = [version] $Matches[1]
  if ($nodeVersion -lt $minimumNodeVersion) {
    $versionMessage = "Node.js $nodeVersion is installed, but this checkout requires $minimumNodeVersion or newer. Update Node.js and reopen the terminal."
    if (-not $AllowUnsupportedNode) {
      Stop-Startup $versionMessage
    }
    Write-Warning "$versionMessage Continuing because -AllowUnsupportedNode was specified."
  }

  if ($ApiPort -eq $WebPort) {
    Stop-Startup 'The API and web server must use different ports.'
  }

  if ($null -ne $DataDir) {
    # powershell.exe and cmd.exe disagree about nested quote preservation in a
    # few invocation forms. Quotes cannot be legal path characters on Windows,
    # so accepting and removing one preserved pair makes the wrapper reliable.
    $DataDir = $DataDir.Trim()
    if ($DataDir.Length -ge 2 -and (
      ($DataDir.StartsWith('"') -and $DataDir.EndsWith('"')) -or
      ($DataDir.StartsWith("'") -and $DataDir.EndsWith("'"))
    )) {
      $DataDir = $DataDir.Substring(1, $DataDir.Length - 2)
    }
  }

  if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $resolvedDataDir = Join-Path $projectRoot '.tavernnext'
  } elseif ([System.IO.Path]::IsPathRooted($DataDir)) {
    $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
  } else {
    $resolvedDataDir = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $DataDir))
  }

  $requiredCommands = @('concurrently.cmd', 'tsx.cmd', 'vite.cmd')
  $missingCommands = @($requiredCommands | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $projectRoot "node_modules\.bin\$_") -PathType Leaf)
  })
  $dependenciesMissing = -not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules') -PathType Container) -or $missingCommands.Count -gt 0

  if ($CheckOnly -and $dependenciesMissing) {
    Stop-Startup "Dependencies are incomplete. Run .\Start-TavernNext.cmd -InstallDependencies."
  }
  if ($InstallDependencies -or $dependenciesMissing) {
    Write-Step 'Installing workspace dependencies with npm install...'
    Push-Location $projectRoot
    try {
      Invoke-Npm -NpmPath $npmPath -Arguments @('install')
    } finally {
      Pop-Location
    }
  }

  if (-not (Test-PortAvailable -Address $ApiHost -Port $ApiPort)) {
    Stop-Startup "API port ${ApiHost}:$ApiPort is already in use. Stop the existing process or pass -ApiPort with a free port."
  }
  if (-not (Test-PortAvailable -Address $WebHost -Port $WebPort)) {
    Stop-Startup "Web port ${WebHost}:$WebPort is already in use. Stop the existing process or pass -WebPort with a free port."
  }

  $apiBrowserHost = Get-BrowserHost -BindHost $ApiHost
  $webBrowserHost = Get-BrowserHost -BindHost $WebHost
  $apiUrl = "http://${apiBrowserHost}:$ApiPort"
  $webUrl = "http://${webBrowserHost}:$WebPort"

  Write-Host ''
  Write-Host 'TavernNext startup configuration' -ForegroundColor Green
  Write-Host "  Node.js : $nodeVersionText ($nodePath)"
  Write-Host "  Data    : $resolvedDataDir"
  Write-Host "  API     : $apiUrl"
  Write-Host "  Web     : $webUrl"
  Write-Host ''

  if ($CheckOnly) {
    Write-Step 'All startup checks passed. No services were started.'
    exit 0
  }

  $env:TAVERNNEXT_DATA_DIR = $resolvedDataDir
  $env:TAVERNNEXT_HOST = $ApiHost
  $env:TAVERNNEXT_PORT = [string] $ApiPort
  $env:TAVERNNEXT_WEB_HOST = $WebHost
  $env:TAVERNNEXT_WEB_PORT = [string] $WebPort
  $env:TAVERNNEXT_API_PROXY_TARGET = $apiUrl

  $browserJob = $null
  if (-not $NoBrowser) {
    $healthUrl = "$apiUrl/api/health"
    $browserJob = Start-Job -ScriptBlock {
      param($HealthUrl, $WebUrl)

      $deadline = [DateTime]::UtcNow.AddSeconds(90)
      while ([DateTime]::UtcNow -lt $deadline) {
        try {
          $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2
          if ($response.StatusCode -eq 200) {
            Start-Sleep -Milliseconds 500
            Start-Process $WebUrl
            return
          }
        } catch {
          Start-Sleep -Milliseconds 500
        }
      }
    } -ArgumentList $healthUrl, $webUrl
  }

  Write-Step 'Starting the API and web development servers. Press Ctrl+C to stop both.'
  Push-Location $projectRoot
  try {
    & $npmPath run dev
    $devExitCode = $LASTEXITCODE
  } finally {
    Pop-Location
    if ($null -ne $browserJob) {
      Stop-Job -Job $browserJob -ErrorAction SilentlyContinue
      Remove-Job -Job $browserJob -Force -ErrorAction SilentlyContinue
    }
  }

  if ($devExitCode -ne 0) {
    Write-Host "TavernNext stopped with exit code $devExitCode." -ForegroundColor Red
    exit $devExitCode
  }
  Write-Step 'TavernNext stopped.'
  exit 0
} catch {
  Write-Host ''
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host 'Run .\Start-TavernNext.cmd -Help to see all startup options.' -ForegroundColor Yellow
  exit 1
}
