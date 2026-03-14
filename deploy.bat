@echo off
cd /d "%~dp0"
echo ========================================
echo  Mobius Vercel Deployment
echo ========================================
echo.

echo [Checking for changes...]
git status --short
echo.

set /p CONFIRM="Proceed with deployment? (Y/N): "
echo.
if /i not "%CONFIRM%"=="Y" (
    echo Deployment cancelled.
    echo.
    pause
    exit /b 0
)

echo [Backup] Creating pre-deploy snapshot...
for /f "tokens=1-4 delims=/ " %%a in ('date /t') do set DSTR=%%d%%b%%c
for /f "tokens=1-2 delims=: " %%a in ('time /t') do set TSTR=%%a%%b
set TSTR=%TSTR: =0%
set BACKUP_NAME=backups\pre-deploy_%DSTR%_%TSTR%.zip
powershell -NoProfile -Command "Compress-Archive -Path 'api','commands.js','index.html','actions.js','vercel.json','server.js','google_api.js' -DestinationPath '%BACKUP_NAME%' -Force"
if exist "%BACKUP_NAME%" (
    echo Backup saved: %BACKUP_NAME%
) else (
    echo WARNING: Backup failed - check PowerShell is available.
)
echo.

set /p MSG="Enter commit message (or press Enter for default): "
if "%MSG%"=="" set MSG=Update Mobius

echo.
echo [1/3] Staging all changes...
git add -A
echo Done.
echo.

echo [2/3] Committing: %MSG%
git commit -m "%MSG%"
echo.

echo [3/3] Pushing to GitHub (Vercel will auto-deploy)...
git push origin main
echo.

if %ERRORLEVEL%==0 (
    echo ========================================
    echo  Success! Vercel is now deploying.
    echo  Check: https://mobius-vercel.vercel.app
    echo  Backup: %BACKUP_NAME%
    echo ========================================
) else (
    echo ========================================
    echo  ERROR: Push failed. Check the output above.
    echo ========================================
)

echo.
pause
