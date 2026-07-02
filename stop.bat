@echo off
echo Stopping Mobius...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$pids = (Get-NetTCPConnection -State Listen -LocalPort 3005 -EA SilentlyContinue).OwningProcess; foreach ($id in $pids) { Stop-Process -Id $id -Force -EA SilentlyContinue; Write-Host 'Stopped PID' $id }"
echo Mobius stopped.
