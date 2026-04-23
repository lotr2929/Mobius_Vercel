# push_env.ps1
# Reads .env.local and upserts all keys to Vercel project environment variables.
# Run from mobius root: powershell -File _dev\push_env.ps1

$ErrorActionPreference = 'Stop'

# Load Vercel credentials from deploy.env
$deployEnv = Get-Content (Join-Path $PSScriptRoot '..\deploy.env') | Where-Object { $_ -match '=' }
$creds = @{}
foreach ($line in $deployEnv) {
    $parts = $line -split '=', 2
    $creds[$parts[0].Trim()] = $parts[1].Trim()
}
$TOKEN      = $creds['VERCEL_TOKEN']
$PROJECT_ID = $creds['VERCEL_PROJECT_ID']
$TEAM_ID    = $creds['VERCEL_TEAM_ID']

if (-not $TOKEN -or -not $PROJECT_ID) {
    Write-Host "ERROR: Missing VERCEL_TOKEN or VERCEL_PROJECT_ID in deploy.env" -ForegroundColor Red
    exit 1
}

$headers = @{
    Authorization  = "Bearer $TOKEN"
    'Content-Type' = 'application/json'
}

$baseUrl = "https://api.vercel.com/v10/projects/$PROJECT_ID/env?teamId=$TEAM_ID"

# Fetch all existing env var IDs upfront
Write-Host "Fetching existing env vars from Vercel..." -ForegroundColor DarkGray
$existing = @{}
try {
    $res = Invoke-RestMethod -Method GET -Uri $baseUrl -Headers $headers
    foreach ($e in $res.envs) {
        $existing[$e.key] = $e.id
    }
    Write-Host "  Found $($existing.Count) existing keys." -ForegroundColor DarkGray
} catch {
    Write-Host "WARNING: Could not fetch existing env vars. Will try POST only." -ForegroundColor Yellow
}

# Parse .env.local
$envFile = Join-Path $PSScriptRoot '..\\.env.local'
$lines   = Get-Content $envFile | Where-Object { $_ -notmatch '^\s*#' -and $_ -match '=' }

$skip = @('VERCEL_TOKEN','VERCEL_PROJECT_ID','VERCEL_TEAM_ID','BASE_URL','MOBIUS_TEST_USER_ID')

$ok = 0; $skipped = 0; $failed = 0

foreach ($line in $lines) {
    $parts = $line -split '=', 2
    $key   = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"').Trim("'")

    if ($skip -contains $key) {
        Write-Host "  SKIP  $key" -ForegroundColor DarkGray
        $skipped++
        continue
    }

    $body = @{
        key    = $key
        value  = $value
        type   = 'encrypted'
        target = @('production', 'preview', 'development')
    } | ConvertTo-Json

    try {
        if ($existing.ContainsKey($key)) {
            # Key exists — PATCH it
            $patchUrl = "https://api.vercel.com/v10/projects/$PROJECT_ID/env/$($existing[$key])?teamId=$TEAM_ID"
            Invoke-RestMethod -Method PATCH -Uri $patchUrl -Headers $headers -Body $body | Out-Null
            Write-Host "  UPD   $key" -ForegroundColor Cyan
        } else {
            # Key does not exist — POST it
            Invoke-RestMethod -Method POST -Uri $baseUrl -Headers $headers -Body $body | Out-Null
            Write-Host "  OK    $key" -ForegroundColor Green
        }
        $ok++
    } catch {
        Write-Host "  FAIL  $key ($_)" -ForegroundColor Red
        $failed++
    }
}

Write-Host ""
Write-Host "Done. $ok pushed/updated, $skipped skipped, $failed failed." -ForegroundColor White
if ($ok -gt 0) {
    Write-Host "Vercel will use new env vars on next deployment." -ForegroundColor Yellow
}
