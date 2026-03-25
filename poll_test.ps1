# poll_test.ps1 - show exactly what one poll returns

$token     = (Get-Content deploy.env | Where-Object { $_ -match '^VERCEL_TOKEN=' })      -replace '^VERCEL_TOKEN=',''
$projectId = (Get-Content deploy.env | Where-Object { $_ -match '^VERCEL_PROJECT_ID=' }) -replace '^VERCEL_PROJECT_ID=',''
$teamId    = (Get-Content deploy.env | Where-Object { $_ -match '^VERCEL_TEAM_ID=' })    -replace '^VERCEL_TEAM_ID=',''

$headers = @{ Authorization = 'Bearer ' + $token }
$url     = "https://api.vercel.com/v6/deployments?projectId=$projectId&teamId=$teamId&limit=1"

$resp = Invoke-RestMethod -Uri $url -Headers $headers
$d    = $resp.deployments[0]

Write-Host ""
Write-Host "uid:       $($d.uid)"
Write-Host "state:     $($d.state)"
Write-Host "createdAt: $($d.createdAt)  (ms)"
Write-Host "now (s):   $([long](Get-Date -UFormat %s))"
Write-Host "now (ms):  $([long](Get-Date -UFormat %s) * 1000)"
Write-Host ""
Write-Host "Press any key to close."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
