# 一键安装：确保 Node 24（缺失则下载便携包到 .runtime\），再交给 bootstrap.mjs。
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Set-Location -LiteralPath $PSScriptRoot

$NodeVersion = if ($env:WEIBO_NODE_VERSION) { $env:WEIBO_NODE_VERSION } else { "v24.22.2" }

function Test-NodeOk {
  $command = Get-Command node -ErrorAction SilentlyContinue
  if (-not $command) { return $false }
  try {
    $major = [int](& node -p "process.versions.node.split('.')[0]")
    return $major -ge 24
  } catch { return $false }
}

function Ensure-Node {
  if (Test-NodeOk) { return }
  $portable = Join-Path $PSScriptRoot ".runtime\node\node.exe"
  if (Test-Path $portable) {
    $env:PATH = (Join-Path $PSScriptRoot ".runtime\node") + ";" + $env:PATH
    if (Test-NodeOk) { return }
  }
  $arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
  $name = "node-$NodeVersion-win-$arch"
  $url = "https://nodejs.org/dist/$NodeVersion/$name.zip"
  Write-Host "未检测到 Node 24，正在下载便携版：$url"
  New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot ".runtime") | Out-Null
  $zip = Join-Path $PSScriptRoot ".runtime\node.zip"
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip -TimeoutSec 120
  $checksums = (Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt" -TimeoutSec 30).Content
  $checksumLine = $checksums -split "`n" | Where-Object { $_.TrimEnd().EndsWith("  $name.zip") } | Select-Object -First 1
  if (-not $checksumLine) { throw "Node 校验清单中没有 $name.zip" }
  $expectedHash = ($checksumLine -split '\s+')[0]
  if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash.ToLowerInvariant()) { throw "Node 下载校验失败，请重新安装" }
  Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $PSScriptRoot ".runtime") -Force
  $extracted = Join-Path $PSScriptRoot ".runtime\$name"
  if (Test-Path (Join-Path $PSScriptRoot ".runtime\node")) { Remove-Item -Recurse -Force (Join-Path $PSScriptRoot ".runtime\node") }
  Rename-Item -LiteralPath $extracted -NewName "node"
  Remove-Item -Force $zip
  $env:PATH = (Join-Path $PSScriptRoot ".runtime\node") + ";" + $env:PATH
  if (-not (Test-NodeOk)) { throw "便携 Node 安装失败" }
}

Ensure-Node
& node bootstrap.mjs install @args
exit $LASTEXITCODE
