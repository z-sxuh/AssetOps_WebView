$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$frontendDirectory = Join-Path $projectRoot 'src/frontend'
$dependenciesDirectory = Join-Path $projectRoot 'app/dependencies'
$modulesDirectory = Join-Path $dependenciesDirectory 'node_modules'
$linkDirectory = Join-Path $frontendDirectory 'node_modules'
$storeDirectory = Join-Path $dependenciesDirectory 'store'

if (Test-Path -LiteralPath $linkDirectory) {
    $link = Get-Item -Force -LiteralPath $linkDirectory
    if ($link.LinkType -ne 'Junction' -or [IO.Path]::GetFullPath($link.Target) -ne [IO.Path]::GetFullPath($modulesDirectory)) {
        throw "Expected $linkDirectory to point to $modulesDirectory."
    }
} else {
    New-Item -ItemType Directory -Force -Path $modulesDirectory | Out-Null
    New-Item -ItemType Junction -Path $linkDirectory -Target $modulesDirectory | Out-Null
}

Push-Location $frontendDirectory
try {
    pnpm install --modules-dir $modulesDirectory --store-dir $storeDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
} finally {
    Pop-Location
}
