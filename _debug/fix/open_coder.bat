# _dev/open_coder.bat: Opens Mobius as a PWA in Edge to initiate the coding session.
@echo off
REM Open mobius as a PWA in Edge.
REM Run this once to start the session. Coder will auto-run session tasks on load.
REM After first Project: Open (one-time), all subsequent refreshes are headless.
start msedge --app=https://mobius.vercel.app
