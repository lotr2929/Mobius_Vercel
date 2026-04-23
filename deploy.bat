@echo off
cd /d "%~dp0"
echo ========================================
echo  Mobius Deployment
echo ========================================
echo.

echo [Checking for changes...]
for /f %%C in ('git status --short ^| find /c /v ""') do set CHANGE_COUNT=%%C
git status --short
echo.

if "%CHANGE_COUNT%"=="0" (
    echo Nothing to deploy. Working tree is clean.
    echo.
    pause
    exit /b 0
)
echo %CHANGE_COUNT% change(s) detected. Deploying...

echo [Cache] Bumping service worker version...
powershell -NoProfile -Command ^
  "$f='service-worker.js';" ^
  "$c=[System.IO.File]::ReadAllText($f);" ^
  "$m=[regex]::Match($c,'mobius-v(\d+)');" ^
  "if($m.Success){$n=[int]$m.Groups[1].Value+1;$c=$c-replace'mobius-v\d+',('mobius-v'+$n);[System.IO.File]::WriteAllText($f,$c);Write-Host('  service-worker.js: mobius-v'+$n)}else{Write-Host'  WARNING: version pattern not found in service-worker.js'}"
echo.

git add -A 2>nul

REM Auto-generate commit message: 3Apr26 11:05am - [N] file1 file2 ...
powershell -NoProfile -Command ^
  "$d=Get-Date;" ^
  "$date=[string]$d.Day+$d.ToString('MMM')+$d.ToString('yy');" ^
  "$time=$d.ToString('h:mmtt').ToLower();" ^
  "$staged=@(& git diff --cached --name-only 2>$null);" ^
  "$n=$staged.Count;" ^
  "$prefix=\"$date $time - [$n] \";" ^
  "$limit=80-$prefix.Length;" ^
  "$names='';" ^
  "foreach($f in $staged){$add=if($names){', '+$f}else{$f}; if(($names+$add).Length -le $limit){$names+=$add}else{break}};" ^
  "$msg=$prefix+$names;" ^
  "[System.IO.File]::WriteAllText('_tmp_msg.txt', $msg, [System.Text.UTF8Encoding]::new($false))"
set /p MSG=<_tmp_msg.txt
del _tmp_msg.txt
echo.

powershell -NoProfile -Command "Write-Host '[2/3] Committing: %MSG%' -ForegroundColor Green"
git commit -m "%MSG%"
if %ERRORLEVEL% NEQ 0 (
    echo Nothing to commit or commit failed. Checking if push is still needed...
    git status --short
)
echo.

echo [3/3] Pushing to GitHub...

REM Load Vercel credentials from deploy.env
if not exist deploy.env (
    echo ERROR: deploy.env not found.
    pause
    goto :end
)
for /f "usebackq tokens=1,* delims==" %%A in ("deploy.env") do (
    if "%%A"=="VERCEL_TOKEN"      set VERCEL_TOKEN=%%B
    if "%%A"=="VERCEL_PROJECT_ID" set VERCEL_PROJECT_ID=%%B
    if "%%A"=="VERCEL_TEAM_ID"    set VERCEL_TEAM_ID=%%B
)

REM Capture baseline uid BEFORE push
for /f "usebackq" %%U in (`powershell -NoProfile -Command "(Invoke-RestMethod 'https://api.vercel.com/v6/deployments?projectId=%VERCEL_PROJECT_ID%&teamId=%VERCEL_TEAM_ID%&limit=1' -Headers @{Authorization='Bearer %VERCEL_TOKEN%'}).deployments[0].uid"`) do set BASELINE_UID=%%U
echo Baseline: %BASELINE_UID%
git push -q origin main
echo.

if %ERRORLEVEL% NEQ 0 (
    echo ========================================
    echo  ERROR: Push failed. Check the output above.
    echo ========================================
    pause
    goto :end
)

echo.
echo Polling Vercel...
echo.

powershell -NoProfile -File _dev\poll_vercel.ps1 -BaselineUid "%BASELINE_UID%"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ========================================
    echo  Deployment failed or timed out.
    echo  Check: https://vercel.com/lotr2929-7612s-projects/mobius
    echo ========================================
) else (
    echo.
    echo ========================================
    echo  Deployment verified.
    echo  URL: https://mobius.vercel.app
    echo ========================================
)

goto :end

:end
echo.
pause
