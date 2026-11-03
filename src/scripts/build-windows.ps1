$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$toolchain = Join-Path $projectRoot 'app/dependencies/toolchain'
$cargoHome = Join-Path $toolchain 'cargo'
$cargoXwin = Join-Path $toolchain 'cargo-xwin'
$sysroot = Join-Path $projectRoot 'app/dependencies/xwin/windows-msvc-sysroot/windows-msvc-sysroot'
$sysrootLib = Join-Path $sysroot 'lib/x86_64-unknown-windows-msvc'
$llvmDirectories = @(Get-ChildItem -LiteralPath (Join-Path $toolchain 'llvm-mingw') -Directory -Filter 'llvm-mingw-*')

if ($llvmDirectories.Count -ne 1) {
    throw 'Expected one LLVM-MinGW toolchain under app/dependencies/toolchain/llvm-mingw.'
}

$llvmBin = Join-Path $llvmDirectories[0].FullName 'bin'
$requiredPaths = @(
    (Join-Path $cargoHome 'bin/cargo.exe'),
    (Join-Path $cargoXwin 'cargo-xwin.exe'),
    (Join-Path $llvmBin 'llvm-rc.exe'),
    (Join-Path $llvmBin 'lld-link.exe'),
    $sysrootLib
)
foreach ($path in $requiredPaths) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Required build dependency is missing: $path" }
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw 'pnpm is required. Run src/scripts/setup-dependencies.ps1 first.'
}

$env:RUSTUP_HOME = Join-Path $toolchain 'rustup'
$env:CARGO_HOME = $cargoHome
$env:CARGO_TARGET_DIR = Join-Path $projectRoot 'app/dependencies/cargo-target'
$env:XWIN_CACHE_DIR = Join-Path $projectRoot 'app/dependencies/xwin'
$env:XWIN_CROSS_COMPILER = 'clang'
$env:LIB = $sysrootLib
$env:INCLUDE = "$sysroot/include/um;$sysroot/include/shared;$sysroot/include/ucrt;$sysroot/include/winrt"
$env:ASSETOPS_LLVM_RC = Join-Path $llvmBin 'llvm-rc.exe'
$env:RC = Join-Path $PSScriptRoot 'llvm-rc-utf8.cmd'
$env:PATH = "$cargoHome/bin;$cargoXwin;$llvmBin;$env:PATH"
$env:CI = 'true'
$env:pnpm_config_verify_deps_before_run = 'false'

$frontendDirectory = Join-Path $projectRoot 'src/frontend'
Push-Location $frontendDirectory
try {
    pnpm tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
    if ($LASTEXITCODE -ne 0) { throw 'Tauri installer build failed.' }
} finally {
    Pop-Location
}

$config = Get-Content -Raw -Encoding UTF8 (Join-Path $frontendDirectory 'src-tauri/tauri.conf.json') | ConvertFrom-Json
$installer = Join-Path $env:CARGO_TARGET_DIR "x86_64-pc-windows-msvc/release/bundle/nsis/$($config.productName)_$($config.version)_x64-setup.exe"
if (-not (Test-Path -LiteralPath $installer)) { throw "Installer was not produced: $installer" }

$displayVersion = $config.version.Replace('+', '.')
$versionDirectory = Join-Path $projectRoot "app/$(Get-Date -Format yyyyMMdd)-v$displayVersion"
New-Item -ItemType Directory -Force -Path $versionDirectory | Out-Null
$package = Join-Path $versionDirectory "$($config.productName)-$displayVersion-x64-Setup.exe"
Copy-Item -LiteralPath $installer -Destination $package -Force
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $package).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$package.sha256" -Value "$hash  $(Split-Path -Leaf $package)" -Encoding utf8
Write-Output "Installer: $package"
Write-Output "SHA256: $hash"
