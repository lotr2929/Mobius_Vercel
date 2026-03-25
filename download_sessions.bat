@echo off
cd /d "%~dp0"
echo ========================================
echo  Mobius Session Downloader
echo ========================================
echo.
echo Enter date range to download (YYYY-MM-DD format).
echo Press Enter to use defaults (yesterday to today).
echo.

set /p DATE_FROM="From date (e.g. 2026-03-24): "
set /p DATE_TO="To date   (e.g. 2026-03-25): "

if "%DATE_FROM%"=="" (
    for /f "usebackq" %%D in (`powershell -NoProfile -Command "(Get-Date).AddDays(-1).ToString('yyyy-MM-dd')"`) do set DATE_FROM=%%D
)
if "%DATE_TO%"=="" (
    for /f "usebackq" %%D in (`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd'"`) do set DATE_TO=%%D
)

echo.
echo Downloading sessions from %DATE_FROM% to %DATE_TO%...
echo.

powershell -NoProfile -File download_sessions.ps1 -DateFrom "%DATE_FROM%" -DateTo "%DATE_TO%"

echo.
pause
