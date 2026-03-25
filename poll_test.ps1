# poll_test.ps1 — standalone Vercel polling diagnostic
# Run from PowerShell in C:\Users\263350F\Mobius\Mobius_Vercel

Write-Host ""
Write-Host "=== Step 1: Reading deploy.env ===" -ForegroundColor Cyan

$token     = (Get-Content deploy.env | Where-Object { $_ -match '^VERCEL_TOKEN=' })      -replace '^VERCEL_TOKEN=',''
$projectId = (Get-Content deploy.env | Where-Object { $_ -match '^VERCEL_PROJECT_ID=' }) -replace '^VERCEL_PROJECT_ID=',''
$teamId    = (Get-Content deploy.env | Where-Object { $_ -match '^VERCEL_TEAM_ID=' })    -replace '^VERCEL_TEAM_ID=',''

Write-Host "Token:     $($token.Substring(0,10))..."
Write-Host "ProjectId: $projectId"
Write-Host "TeamId:    $teamId"

Write-Host ""
Write-Host "=== Step 2: Calling Vercel API ===" -ForegroundColor Cyan

$headers = @{ Authorization = 'Bearer ' + $token }
$url = "https://api.vercel.com/v6/deployments?projectId=$projectId&teamId=$teamId&limit=3"
Write-Host "URL: $url"
Write-Host ""

try {
    $resp = Invoke-RestMethod -Uri $url -Headers $headers -ErrorAction Stop
    Write-Host "=== Step 3: Recent deployments ===" -ForegroundColor Cyan
    $resp.deployments | Select-Object name, state, createdAt | Format-Table -AutoSize
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "Full error:" -ForegroundColor Yellow
    $_ | Format-List *
}

Write-Host ""
Write-Host "=== Step 4: Simulating polling loop (5 iterations) ===" -ForegroundColor Cyan

$rawTime = [long](Get-Date -UFormat %s)
$pushStartMs = $rawTime - 3600000L  # subtract 1 hour in ms — no multiplication
Write-Host "rawTime:     $rawTime"
Write-Host "pushStartMs: $pushStartMs"
Write-Host "latest createdAt: $([long]$resp.deployments[0].createdAt)"
$waited = 0
$interval = 5

for ($i = 1; $i -le 5; $i++) {
    $new = $resp.deployments | Where-Object { [long]$_.createdAt -gt $pushStartMs } | Select-Object -First 1
    if ($new) {
        Write-Host "  Found deployment: $($new.name) | state=$($new.state) | createdAt=$($new.createdAt)"
    } else {
        Write-Host "  No deployment found after pushStartMs=$pushStartMs"
    }
    Start-Sleep -Seconds 1
}

Write-Host ""
Write-Host "=== Done. Press any key to close. ===" -ForegroundColor Cyan
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
