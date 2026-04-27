@echo off
cd /d "%~dp0"

REM ============================================================
REM Generic deploy.bat - drops into any Vercel-deployed repo
REM Requires deploy.env: VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID,
REM                      PROJECT_NAME, DEPLOY_URL, optional SW_PREFIX
REM Requires _dev\poll_vercel.ps1
REM ============================================================

REM -- Pre-flight: Google Drive sync conflict check
if exist ".tmp.driveupload\*" (
    echo Google Drive is mid-sync. Wait ~30s and retry.
    pause
    exit /b 1
)

REM -- Load deploy.env
if not exist deploy.env (
    echo deploy.env missing.
    pause
    exit /b 1
)
for /f "usebackq tokens=1,* delims==" %%A in ("deploy.env") do (
    if "%%A"=="VERCEL_TOKEN"      set VERCEL_TOKEN=%%B
    if "%%A"=="VERCEL_PROJECT_ID" set VERCEL_PROJECT_ID=%%B
    if "%%A"=="VERCEL_TEAM_ID"    set VERCEL_TEAM_ID=%%B
    if "%%A"=="PROJECT_NAME"      set PROJECT_NAME=%%B
    if "%%A"=="DEPLOY_URL"        set DEPLOY_URL=%%B
    if "%%A"=="SW_PREFIX"         set SW_PREFIX=%%B
)
if not defined PROJECT_NAME set PROJECT_NAME=project

echo. 
echo ==============================================================
echo                    Mobius PWA Deploying... 
echo ==============================================================
echo. 

REM -- Bump service-worker version (only if SW_PREFIX set and file exists)
if defined SW_PREFIX if exist service-worker.js (
    powershell -NoProfile -Command "$f='service-worker.js';$c=[IO.File]::ReadAllText($f);$m=[regex]::Match($c,'%SW_PREFIX%(\d+)');if($m.Success){$n=[int]$m.Groups[1].Value+1;$c=$c -replace '%SW_PREFIX%\d+',('%SW_PREFIX%'+$n);[IO.File]::WriteAllText($f,$c);Write-Host('SW -> %SW_PREFIX%'+$n)}"
)

REM -- Stage all changes
git add -A 2>nul

REM -- Bail to push if nothing to commit
git diff-index --quiet HEAD
if %errorlevel% equ 0 (
    echo No changes. Pushing current HEAD.
    goto :push
)

REM -- Auto commit message: 26Apr26 9:55pm - [N] file1, file2, file3, file4...
powershell -NoProfile -Command "$d=Get-Date;$p=([string]$d.Day+$d.ToString('MMM')+$d.ToString('yy'))+' '+$d.ToString('h:mmtt').ToLower();$s=@(& git diff --cached --name-only);$n=$s.Count;$names=($s | ForEach-Object { Split-Path $_ -Leaf } | Select-Object -First 4) -join ', ';$tail=if($n -gt 4){'...'}else{''};[IO.File]::WriteAllText('_msg.tmp', \"$p - [$n] $names$tail\", [Text.UTF8Encoding]::new($false))"
set /p MSG=<_msg.tmp
del _msg.tmp 2>nul

powershell -NoProfile -Command "Write-Host 'Commit: %MSG%' -ForegroundColor Green"
git commit -q -m "%MSG%"
if %ERRORLEVEL% NEQ 0 (
    echo Commit failed.
    pause
    exit /b 1
)

:push
echo Pulling...
git pull --rebase --quiet origin main
if %ERRORLEVEL% NEQ 0 (
    echo Pull failed. Resolve conflicts and retry.
    pause
    exit /b 1
)

REM -- Capture baseline deployment uid before push
for /f "usebackq" %%U in (`powershell -NoProfile -Command "(Invoke-RestMethod 'https://api.vercel.com/v6/deployments?projectId=%VERCEL_PROJECT_ID%&teamId=%VERCEL_TEAM_ID%&limit=1' -Headers @{Authorization='Bearer %VERCEL_TOKEN%'}).deployments[0].uid"`) do set BASELINE_UID=%%U

echo Pushing...
git push -q origin main
if %ERRORLEVEL% NEQ 0 (
    echo Push failed.
    pause
    exit /b 1
)

echo Polling Vercel...
powershell -NoProfile -File _dev\poll_vercel.ps1 -BaselineUid "%BASELINE_UID%"
if %ERRORLEVEL% NEQ 0 (
    echo Deploy failed or timed out.
    pause
    exit /b 1
)

echo.
if defined DEPLOY_URL (
    powershell -NoProfile -Command "Write-Host 'Live: ' -NoNewline; Write-Host ('%DEPLOY_URL%')-ForegroundColor Green"
) else (
    echo Done.
)
pause
