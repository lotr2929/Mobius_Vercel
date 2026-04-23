# check_ollama.ps1
# Checks whether Ollama is running and reachable
# Run from anywhere: powershell -File _dev\check_ollama.ps1

Write-Host ""
Write-Host "=== Ollama Diagnostics ===" -ForegroundColor Cyan
Write-Host ""

# 1. Is the Ollama process running?
$proc = Get-Process -Name "ollama" -ErrorAction SilentlyContinue
if ($proc) {
    Write-Host "  PASS  Ollama process is running (PID $($proc.Id))" -ForegroundColor Green
} else {
    Write-Host "  FAIL  Ollama process not found" -ForegroundColor Red
    Write-Host "        Start it with: start-ollama.bat or 'ollama serve'" -ForegroundColor Yellow
}

Write-Host ""

# 2. Is port 11434 listening?
$port = netstat -ano | Select-String ":11434"
if ($port) {
    Write-Host "  PASS  Port 11434 is open:" -ForegroundColor Green
    $port | ForEach-Object { Write-Host "        $_" -ForegroundColor DarkGray }
} else {
    Write-Host "  FAIL  Port 11434 is not listening" -ForegroundColor Red
}

Write-Host ""

# 3. Can we reach the Ollama API?
try {
    $r = Invoke-RestMethod "http://localhost:11434/api/tags" -TimeoutSec 5 -ErrorAction Stop
    $models = ($r.models | ForEach-Object { $_.name }) -join ", "
    Write-Host "  PASS  Ollama API reachable" -ForegroundColor Green
    Write-Host "        Models loaded: $($models -or '(none)')" -ForegroundColor DarkGray
} catch {
    Write-Host "  FAIL  Ollama API unreachable: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""

# 4. Check OLLAMA_ORIGINS env var (controls CORS)
$origins = [System.Environment]::GetEnvironmentVariable("OLLAMA_ORIGINS", "User")
$originsM = [System.Environment]::GetEnvironmentVariable("OLLAMA_ORIGINS", "Machine")
if ($origins -or $originsM) {
    Write-Host "  INFO  OLLAMA_ORIGINS set: user='$origins' machine='$originsM'" -ForegroundColor Cyan
} else {
    Write-Host "  INFO  OLLAMA_ORIGINS not set (default: localhost only)" -ForegroundColor Yellow
    Write-Host "        If browser fetch fails from HTTPS, set OLLAMA_ORIGINS=*" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Cyan
Write-Host ""
pause
