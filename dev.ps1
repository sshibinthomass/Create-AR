# Starts the backend and the Vite dev server together.
#   powershell -ExecutionPolicy Bypass -File dev.ps1
param([int]$Port = 8080)

$root = $PSScriptRoot
$python = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) {
    Write-Error "No virtualenv at .venv -- run: python -m venv .venv; .venv\Scripts\pip install -e 'backend[dev]'"
    exit 1
}

Write-Host "Backend  -> http://127.0.0.1:$Port" -ForegroundColor Cyan
$api = Start-Process -PassThru -NoNewWindow $python `
    @('-m', 'uvicorn', 'app.main:app', '--app-dir', "$root\backend", '--port', "$Port", '--reload')

Write-Host "Frontend -> http://localhost:5173" -ForegroundColor Cyan
$env:CONVERTER_PORT = $Port
try {
    npm --prefix "$root\frontend" run dev
} finally {
    if (-not $api.HasExited) { Stop-Process -Id $api.Id -Force }
}
