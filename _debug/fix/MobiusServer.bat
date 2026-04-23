# MobiusServer.bat — manual launch script for starting the Mobius local server from the command line.
@echo off
rem MobiusServer.bat — manual launch only
rem At startup, Windows runs MobiusServer.vbs instead (no visible window)
rem Run this .bat manually only if you want to see the server console output

cd /d C:\Users\263350F\Mobius\Mobius_Vercel
echo Starting Mobius local server on http://localhost:3000
echo Close this window to stop the server.
echo.
node server.js
