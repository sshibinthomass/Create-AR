# Starts the backend and the Vite dev server together.
#   powershell -ExecutionPolicy Bypass -File dev.ps1
#   powershell -ExecutionPolicy Bypass -File dev.ps1 -Port 9000 -UiPort 5200
param(
    [int]$Port = 8080,
    [int]$UiPort = 5180
)

$root = $PSScriptRoot
$python = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) {
    Write-Error "No virtualenv at .venv -- run: python -m venv .venv; .venv\Scripts\python.exe -m pip install -e 'backend[dev]'"
    exit 1
}

function Test-PortBusy([int]$p) {
    (Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue) -ne $null
}

foreach ($pair in @(@{ N = 'Backend'; P = $Port }, @{ N = 'Frontend'; P = $UiPort })) {
    if (Test-PortBusy $pair.P) {
        Write-Error "$($pair.N) port $($pair.P) is already in use. Pass a different one, e.g. -Port 9000 -UiPort 5200"
        exit 1
    }
}

Write-Host "Backend  -> http://127.0.0.1:$Port" -ForegroundColor Cyan
$api = Start-Process -PassThru -NoNewWindow $python `
    @('-m', 'uvicorn', 'app.main:app', '--app-dir', "$root\backend", '--port', "$Port", '--reload')

Write-Host "Frontend -> http://localhost:$UiPort" -ForegroundColor Cyan
$env:CONVERTER_PORT = $Port
$env:CONVERTER_UI_PORT = $UiPort
try {
    npm --prefix "$root\frontend" run dev
} finally {
    if (-not $api.HasExited) { Stop-Process -Id $api.Id -Force }
}
