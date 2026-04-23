$e = Get-Content 'C:\_myProjects\Mobius\Mobius\deploy.env' | ConvertFrom-StringData
$url = "https://api.vercel.com/v6/deployments?projectId=$($e.VERCEL_PROJECT_ID)&teamId=$($e.VERCEL_TEAM_ID)&limit=3"
$r = Invoke-RestMethod $url -Headers @{Authorization="Bearer $($e.VERCEL_TOKEN)"}
$r.deployments | Select-Object uid, state, createdAt | Format-Table -AutoSize
