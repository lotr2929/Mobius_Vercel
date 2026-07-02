@echo off
cd /d D:\_myProjects\_Mobius\Mobius

echo Starting Mobius on port 3005...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ports = @(3005); foreach ($p in $ports) { $pids = (Get-NetTCPConnection -State Listen -LocalPort $p -EA SilentlyContinue).OwningProcess; foreach ($id in $pids) { Stop-Process -Id $id -Force -EA SilentlyContinue } }; Start-Sleep 1; $node = 'C:\Program Files\nodejs\node.exe'; $base = 'D:\_myProjects\_Mobius\Mobius'; Start-Process $node -ArgumentList \"$base\backend\server.js\" -WindowStyle Hidden -RedirectStandardOutput \"$base\_dev\server.log\" -RedirectStandardError \"$base\_dev\server_err.log\"; Write-Host 'Mobius started.'"

start "" "http://localhost:3005"
