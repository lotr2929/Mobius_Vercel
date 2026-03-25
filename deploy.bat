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

REM Record push time for elapsed timer
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

REM Load Vercel polling credentials from deploy.env (not tracked by git)
if not exist deploy.env (
    echo ERROR: deploy.env not found. Create it with VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID.
    pause
    goto :end
)
for /f "usebackq tokens=1,* delims==" %%A in ("deploy.env") do (
    if "%%A"=="VERCEL_TOKEN"      set VERCEL_TOKEN=%%B
    if "%%A"=="VERCEL_PROJECT_ID" set VERCEL_PROJECT_ID=%%B
    if "%%A"=="VERCEL_TEAM_ID"    set VERCEL_TEAM_ID=%%B
)

REM Poll Vercel API — only match deployments created AFTER the push
powershell -NoProfile -Command ^
    "$token     = '%VERCEL_TOKEN%'; ^
     $projectId = '%VERCEL_PROJECT_ID%'; ^
     $teamId    = '%VERCEL_TEAM_ID%'; ^
     $pushStart = %PUSH_START%; ^
     if (-not $token) { Write-Host '  ERROR: VERCEL_TOKEN not loaded'; exit 1 } ^
     $headers   = @{ Authorization = 'Bearer ' + $token }; ^
     $url       = 'https://api.vercel.com/v6/deployments?projectId=' + $projectId + '&teamId=' + $teamId + '&limit=10'; ^
     $maxWait   = 300; ^
     $interval  = 5; ^
     $waited    = 0; ^
     $found     = $false; ^
     $pushStartMs = [long]$pushStart; ^
     Write-Host '  Waiting for new deployment to appear...'; ^
     while ($waited -le $maxWait) { ^
         try { ^
             $resp = Invoke-RestMethod -Uri $url -Headers $headers -Method Get -ErrorAction Stop; ^
             $new  = $resp.deployments | Where-Object { [long]$_.createdAt -gt $pushStartMs } | Select-Object -First 1; ^
             $now     = [int](Get-Date -UFormat %%s); ^
             $elapsed = $now - $pushStart; ^
             $timer   = ('{0}:{1:D2}' -f [math]::Floor($elapsed/60), $elapsed %% 60); ^
             if ($new) { ^
                 $state = $new.state; ^
                 Write-Host ('  [{0}]  Status: {1}' -f $timer, $state); ^
                 if ($state -eq 'READY') { ^
                     Write-Host ''; Write-Host ''; ^
                     Write-Host ('  Deployment READY in {0}.' -f $timer); ^
                     $found = $true; break; ^
                 } elseif ($state -eq 'ERROR') { ^
                     Write-Host ''; Write-Host ''; ^
                     Write-Host ('  Deployment FAILED after {0}.' -f $timer); ^
                     exit 1; ^
                 } ^
             } else { ^
                 Write-Host ('  [{0}]  Waiting for deployment to queue...' -f $timer); ^
             } ^
         } catch { ^
             Write-Host ('  Polling error: ' + $_.Exception.Message); ^
         } ^
         Start-Sleep -Seconds $interval; ^
         $waited += $interval; ^
     } ^
     if (-not $found) { ^
         Write-Host '  Timed out after 5 minutes.'; ^
         exit 1; ^
     }"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ========================================
    echo  Deployment failed or timed out.
    echo  Check: https://vercel.com/lotr2929-7612s-projects/mobius
    echo ========================================
    pause
    goto :end
)

REM Pause so you can read the deployment time before self-test starts
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


