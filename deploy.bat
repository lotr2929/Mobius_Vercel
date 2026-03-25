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
for /f "usebackq" %%T in (`powershell -NoProfile -Command "Get-Date -Format 'ddMMMyy_HHmm'"`) do set TIMESTAMP=%%T
set BACKUP_NAME=backups\Predeploy-%TIMESTAMP%.zip
powershell -NoProfile -Command "Compress-Archive -Path 'api','commands.js','index.html','actions.js','vercel.json','server.js','google_api.js','self_test.js' -DestinationPath '%BACKUP_NAME%' -Force"
if exist "%BACKUP_NAME%" (
    echo Backup saved: %BACKUP_NAME%
) else (
    echo WARNING: Backup failed.
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
if %ERRORLEVEL% NEQ 0 (
    echo Nothing to commit or commit failed. Checking if push is still needed...
    git status --short
)
echo.

echo [3/3] Pushing to GitHub (Vercel will auto-deploy)...

REM Record push time as Unix seconds
for /f "usebackq" %%T in (`powershell -NoProfile -Command "[long](Get-Date -UFormat %%s)"`) do set PUSH_START=%%T

git push origin main
echo.

if %ERRORLEVEL% NEQ 0 (
    echo ========================================
    echo  ERROR: Push failed. Check the output above.
    echo ========================================
    pause
    goto :end
)

echo.
echo ========================================
echo  Pushed. Polling Vercel for deployment status...
echo ========================================
echo.

powershell -NoProfile -File poll_vercel.ps1 -PushStart %PUSH_START%

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ========================================
    echo  Deployment failed or timed out.
    echo  Check: https://vercel.com/lotr2929-7612s-projects/mobius
    echo ========================================
    pause
    goto :end
)

echo.
pause
echo.
echo [4/4] Running self-test against live deployment...
echo.
node self_test.js

if %ERRORLEVEL%==0 (
    echo.
    echo ========================================
    echo  Deployment verified. Mobius is healthy.
    echo  URL:    https://mobius-vercel.vercel.app
    echo  Backup: %BACKUP_NAME%
    echo ========================================
) else (
    echo.
    echo ========================================
    echo  Self-test FAILED. Review above.
    echo  To rollback: git revert HEAD then deploy.bat
    echo ========================================
)

:end
echo.
pause
exit /b 0
