# poll_vercel.ps1 - called by deploy.bat after git push
# Usage: powershell -File poll_vercel.ps1 -PushStart <unix_seconds>
param(
    [long]$PushStart = 0
)

# Load credentials from deploy.env
$token     = (Get-Content deploy.env | Where-Object { $_ -match '^VERCEL_TOKEN=' })      -replace '^VERCEL_TOKEN=',''
$projectId = (Get-Content deploy.env | Where-Object { $_ -match '^VERCEL_PROJECT_ID=' }) -replace '^VERCEL_PROJECT_ID=',''
$teamId    = (Get-Content deploy.env | Where-Object { $_ -match '^VERCEL_TEAM_ID=' })    -replace '^VERCEL_TEAM_ID=',''

if (-not $token) {
    Write-Host "ERROR: VERCEL_TOKEN not loaded from deploy.env" -ForegroundColor Red
    exit 1
}

$headers     = @{ Authorization = 'Bearer ' + $token }
$url         = "https://api.vercel.com/v6/deployments?projectId=$projectId&teamId=$teamId&limit=10"
$maxWait     = 300
$interval    = 5
$waited      = 0
$found       = $false
$sawBuilding = $false

Write-Host "  Waiting for new deployment to appear..."

while ($waited -le $maxWait) {
    try {
        $resp    = Invoke-RestMethod -Uri $url -Headers $headers -Method Get -ErrorAction Stop
        $new     = $resp.deployments | Where-Object { [long]$_.createdAt -gt $PushStart } | Select-Object -First 1
        $elapsed = [int](Get-Date -UFormat %s) - $PushStart
        $timer   = '{0}:{1:D2}' -f [math]::Floor($elapsed / 60), ($elapsed % 60)

        if ($new) {
            $state = $new.state
            if ($state -eq 'BUILDING' -or $state -eq 'INITIALIZING') { $sawBuilding = $true }
            Write-Host "  [$timer]  Status: $state"
            if ($state -eq 'READY' -and $sawBuilding) {
                Write-Host ""
                Write-Host "  Deployment READY in $timer." -ForegroundColor Green
                $found = $true
                break
            } elseif ($state -eq 'READY' -and -not $sawBuilding) {
                Write-Host "  [$timer]  Stale deployment - waiting for new build..."
            } elseif ($state -eq 'ERROR') {
                Write-Host ""
                Write-Host "  Deployment FAILED after $timer." -ForegroundColor Red
                exit 1
            }
        } else {
            Write-Host "  [$timer]  Waiting for deployment to queue..."
        }
    } catch {
        Write-Host "  Polling error: $($_.Exception.Message)" -ForegroundColor Yellow
    }

    Start-Sleep -Seconds $interval
    $waited += $interval
}

if (-not $found) {
    Write-Host "  Timed out after 5 minutes." -ForegroundColor Red
    exit 1
}
