# poll_test.ps1 - test the 'since' parameter to find new deployments
# Run BEFORE a deploy, keep running, then trigger deploy.bat in another window

$token     = (Get-Content deploy.env | Where-Object { $_ -match '^VERCEL_TOKEN=' })      -replace '^VERCEL_TOKEN=',''
$projectId = (Get-Content deploy.env | Where-Object { $_ -match '^VERCEL_PROJECT_ID=' }) -replace '^VERCEL_PROJECT_ID=',''
$teamId    = (Get-Content deploy.env | Where-Object { $_ -match '^VERCEL_TEAM_ID=' })    -replace '^VERCEL_TEAM_ID=',''

$headers  = @{ Authorization = 'Bearer ' + $token }
$nowMs    = [long](Get-Date -UFormat %s) * 1000
$start    = [int](Get-Date -UFormat %s)

# Use 'since' to ask Vercel for deployments created after right now
$url = "https://api.vercel.com/v6/deployments?projectId=$projectId&teamId=$teamId&limit=5&since=$nowMs"

Write-Host ""
Write-Host "now (ms): $nowMs"
Write-Host "Polling with since=$nowMs - only new deployments should appear."
Write-Host "Trigger deploy.bat in another window now."
Write-Host "Press Ctrl+C to stop."
Write-Host ""

while ($true) {
    $elapsed = [int](Get-Date -UFormat %s) - $start
    $timer   = '{0}:{1:D2}' -f [math]::Floor($elapsed / 60), ($elapsed % 60)

    try {
        $resp = Invoke-RestMethod -Uri $url -Headers $headers -Method Get -ErrorAction Stop
        if ($resp.deployments.Count -eq 0) {
            Write-Host "[$timer]  No new deployments yet..."
        } else {
            foreach ($d in $resp.deployments) {
                Write-Host "[$timer]  uid=$($d.uid)  state=$($d.state)  createdAt=$($d.createdAt)"
            }
        }
    } catch {
        Write-Host "[$timer] ERROR: $($_.Exception.Message)" -ForegroundColor Red
    }

    Start-Sleep -Seconds 5
}
