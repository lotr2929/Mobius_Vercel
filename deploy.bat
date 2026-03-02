@echo off
echo ========================================
echo  Mobius Vercel Deployment
echo ========================================
echo.

REM Check for uncommitted changes first?
set /p CHECK="Check for changes before deploying? (Y/N): "
echo.

if /i "%CHECK%"=="Y" (
    echo [Checking for changes...]
    git status --short
    echo.
    git diff --stat
    echo.

    REM Count changed files
    for /f %%i in ('git status --short ^| find /c /v ""') do set CHANGES=%%i

    if "%CHANGES%"=="0" (
        echo No changes detected. Nothing to deploy.
        echo.
        pause
        exit /b 0
    )

    echo %CHANGES% file(s) have changes.
    echo.
    set /p CONFIRM="Proceed with deployment? (Y/N): "
    echo.
    if /i not "%CONFIRM%"=="Y" (
        echo Deployment cancelled.
        echo.
        pause
        exit /b 0
    )
)

REM Get commit message
set /p MSG="Enter commit message (or press Enter for default): "
if "%MSG%"=="" set MSG=Update Mobius

echo.
echo [1/3] Staging all changes...
git add .
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
    echo ========================================
) else (
    echo ========================================
    echo  ERROR: Push failed. Check the output above.
    echo ========================================
)

echo.
pause
