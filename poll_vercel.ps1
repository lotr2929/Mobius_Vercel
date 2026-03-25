# poll_vercel.ps1 - diagnostic mode: print raw Vercel response every 5 seconds
# Press Ctrl+C to stop
param(
    [string]$BaselineUid = ""
)

$token     = (Get-Content deploy.env | Where-Object { $_ -match '^VERCEL_TOKEN=' })      -replace '^VERCEL_TOKEN=',''
$projectId = (Get-Content deploy.env | Where-Object { $_ -match '^VERCEL_PROJECT_ID=' }) -replace '^VERCEL_PROJECT_ID=',''
$teamId    = (Get-Content deploy.env | Where-Object { $_ -match '^VERCEL_TEAM_ID=' })    -replace '^VERCEL_TEAM_ID=',''

$headers = @{ Authorization = 'Bearer ' + $token }
$url     = "https://api.vercel.com/v6/deployments?projectId=$projectId&teamId=$teamId&limit=3"
$start   = [int](Get-Date -UFormat %s)

Write-Host ""
Write-Host "Baseline uid: $BaselineUid"
Write-Host "Polling every 5 seconds. Press Ctrl+C to stop."
Write-Host ""

while ($true) {
    $elapsed = [int](Get-Date -UFormat %s) - $start
    $timer   = '{0}:{1:D2}' -f [math]::Floor($elapsed / 60), ($elapsed % 60)

    try {
        $resp = Invoke-RestMethod -Uri $url -Headers $headers -Method Get -ErrorAction Stop
        Write-Host "[$timer] --- Poll ---"
        foreach ($d in $resp.deployments) {
            $marker = if ($d.uid -eq $BaselineUid) { " <-- BASELINE" } else { "" }
            Write-Host "  uid:       $($d.uid)$marker"
            Write-Host "  state:     $($d.state)"
            Write-Host "  createdAt: $($d.createdAt)"
            Write-Host ""
        }
    } catch {
        Write-Host "[$timer] ERROR: $($_.Exception.Message)" -ForegroundColor Red
    }

    Start-Sleep -Seconds 5
}
