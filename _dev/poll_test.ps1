# poll_test.ps1 - list all projects to verify correct project ID
$token  = (Get-Content deploy.env | Where-Object { $_ -match '^VERCEL_TOKEN=' })  -replace '^VERCEL_TOKEN=',''
$teamId = (Get-Content deploy.env | Where-Object { $_ -match '^VERCEL_TEAM_ID=' }) -replace '^VERCEL_TEAM_ID=',''

$headers = @{ Authorization = "Bearer $token" }

Write-Host ""
Write-Host "Listing all projects for team: $teamId"
Write-Host ""

$resp = Invoke-RestMethod -Uri "https://api.vercel.com/v9/projects?teamId=$teamId" -Headers $headers
$resp.projects | Select-Object name, id | Format-Table -AutoSize

Write-Host "Press any key to close."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
