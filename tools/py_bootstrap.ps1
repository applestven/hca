Param(
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot ".."))
)

$ErrorActionPreference = 'Stop'

function Info([string]$msg) {
  Write-Host "[py:bootstrap] $msg"
}

function Fail([string]$msg) {
  Write-Error "[py:bootstrap] $msg"
  exit 1
}

Set-Location $ProjectRoot

$pyHome  = Join-Path $ProjectRoot "resources\python"
$pyExe   = Join-Path $pyHome "python.exe"
$pth     = Join-Path $pyHome "python311._pth"
$zip     = Join-Path $pyHome "python311.zip"
$dll     = Join-Path $pyHome "python311.dll"
$dllsDir = Join-Path $pyHome "DLLs"
$getPip  = Join-Path $pyHome "get-pip.py"
$req     = Join-Path $ProjectRoot "scripts\codeApp\requirements.txt"
$target  = Join-Path $pyHome "Lib\site-packages"

Info "projectRoot=$ProjectRoot"
Info "pythonHome=$pyHome"

if (!(Test-Path $pyExe)) { Fail "Missing: $pyExe" }
if (!(Test-Path $pth))  { Fail "Missing: $pth" }
if (!(Test-Path $zip))  { Fail "Missing: $zip" }
if (!(Test-Path $dll))  { Fail "Missing: $dll" }

# Ensure site-packages directory exists
if (!(Test-Path $target)) {
  New-Item -ItemType Directory -Force -Path $target | Out-Null
}

# Ensure python311._pth enables stdlib & site-packages
$pthText = ""
try {
  $pthText = Get-Content -Raw -Encoding UTF8 $pth
} catch {
  $pthText = Get-Content -Raw $pth
}

$needWrite = $false
if ($pthText -notmatch "(?m)^Lib$") { $needWrite = $true }
if ($pthText -notmatch "(?m)^Lib\\site-packages$") { $needWrite = $true }
if ($pthText -match "(?m)^#import site\s*$") { $needWrite = $true }
if ($pthText -notmatch "(?m)^import site\s*$") { $needWrite = $true }

if ($needWrite) {
  Info "patch python311._pth"
  $new = @(
    "python311.zip",
    ".",
    "Lib",
    "Lib\\site-packages",
    "",
    "# Uncomment to run site.main() automatically",
    "import site",
    ""
  ) -join "`r`n"

  Set-Content -Encoding Ascii -Path $pth -Value $new
}

Info "check python (encodings)"
& $pyExe -c "import encodings; print('encodings ok')" | Out-Host

# Check pip
$hasPip = $true
try {
  & $pyExe -m pip --version | Out-Host
} catch {
  $hasPip = $false
}

if (-not $hasPip) {
  Info "pip not available; bootstrap via get-pip.py"

  # embedded often lacks ensurepip; verify DLLs/_socket first
  if (!(Test-Path $dllsDir)) {
    Fail "Missing: $dllsDir. Copy the whole 'DLLs' folder from python-3.11.9-embed-amd64.zip into resources\\python\\DLLs"
  }

  $socketOk = $true
  try {
    & $pyExe -c "import _socket; print('_socket ok')" | Out-Host
  } catch {
    $socketOk = $false
  }

  if (-not $socketOk) {
    Fail "Cannot import _socket. Ensure resources\\python\\DLLs contains _socket.pyd"
  }

  if (!(Test-Path $getPip)) {
    Info "डाउनloading get-pip.py"
    Invoke-WebRequest -UseBasicParsing -Uri https://bootstrap.pypa.io/get-pip.py -OutFile $getPip
  }

  Info "run get-pip.py"
  & $pyExe $getPip --no-warn-script-location | Out-Host

  Info "check pip after install"
  & $pyExe -m pip --version | Out-Host
}

if (!(Test-Path $req)) {
  Fail "Missing: $req"
}

Info "install requirements to $target"
& $pyExe -m pip install -r $req --target $target --no-warn-script-location | Out-Host

Info "done"
