# fetch_logs.ps1
# Fetches the latest Vercel function logs to diagnose errors
# Run from mobius root: powershell -File _dev\fetch_logs.ps1

$envPath = Join-Path $PSScriptRoot "..\deploy.env"
$t  = (Get-Content $envPath | Where-Object {$_ -match '^VERCEL_TOKEN='})      -replace '^VERCEL_TOKEN=',''
$p  = (Get-Content $envPath | Where-Object {$_ -match '^VERCEL_PROJECT_ID='}) -replace '^VERCEL_PROJECT_ID=',''
$tm = (Get-Content $envPath | Where-Object {$_ -match '^VERCEL_TEAM_ID='})    -replace '^VERCEL_TEAM_ID=',''

$headers = @{ Authorization = "Bearer $t" }

# Get latest deployment
Write-Host "Fetching latest deployment..." -ForegroundColor Cyan
$dep = (Invoke-RestMethod "https://api.vercel.com/v6/deployments?projectId=$p&teamId=$tm&limit=1" -Headers $headers).deployments[0]
Write-Host "  UID:   $($dep.uid)" -ForegroundColor White
Write-Host "  State: $($dep.state)" -ForegroundColor White
Write-Host "  URL:   $($dep.url)" -ForegroundColor White
Write-Host ""

# Ping the health endpoint to trigger a fresh log entry
Write-Host "Pinging /api/health to generate a fresh log entry..." -ForegroundColor Cyan
try {
    $ping = Invoke-RestMethod "https://$($dep.url)/api/health" -ErrorAction Stop
    Write-Host "  Response: $($ping | ConvertTo-Json -Compress)" -ForegroundColor Green
} catch {
    Write-Host "  Ping failed: $($_.Exception.Message)" -ForegroundColor Red
}
Write-Host ""

# Fetch runtime logs
Write-Host "Fetching runtime logs..." -ForegroundColor Cyan
try {
    $logs = Invoke-RestMethod "https://api.vercel.com/v2/deployments/$($dep.uid)/events?teamId=$tm&limit=100" -Headers $headers
    $entries = $logs | Where-Object { $_.type -eq 'stderr' -or $_.type -eq 'stdout' -or $_.type -eq 'error' }
    if ($entries.Count -eq 0) {
        Write-Host "  No log entries found. Try the Vercel dashboard: https://vercel.com/lotr2929-7612s-projects/mobius/logs" -ForegroundColor Yellow
    } else {
        foreach ($e in $entries | Select-Object -Last 40) {
            $text = if ($e.payload.text) { $e.payload.text } elseif ($e.payload.info) { $e.payload.info } elseif ($e.text) { $e.text } else { '' }
            if ($text) { Write-Host "  $text" -ForegroundColor $(if ($e.type -eq 'stderr') {'Red'} else {'Gray'}) }
        }
    }
} catch {
    Write-Host "  Log fetch failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Check logs directly: https://vercel.com/lotr2929-7612s-projects/mobius/logs" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done." -ForegroundColor White
pause
