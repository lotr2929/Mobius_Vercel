# verify_env.ps1
# Validates all critical env vars in .env.local before deployment
# Run from mobius root: powershell -File _dev\verify_env.ps1

$envFile = Join-Path $PSScriptRoot '..\\.env.local'
$lines   = Get-Content $envFile | Where-Object { $_ -notmatch '^\s*#' -and $_ -match '=' }
$env     = @{}
foreach ($line in $lines) {
    $parts = $line -split '=', 2
    $env[$parts[0].Trim()] = $parts[1].Trim().Trim('"').Trim("'")
}

$pass = 0; $fail = 0

function Check($label, $block) {
    try {
        $result = & $block
        if ($result) {
            Write-Host "  PASS  $label" -ForegroundColor Green
            $script:pass++
        } else {
            Write-Host "  FAIL  $label" -ForegroundColor Red
            $script:fail++
        }
    } catch {
        Write-Host "  FAIL  $label -- $($_.Exception.Message)" -ForegroundColor Red
        $script:fail++
    }
}

Write-Host ""
Write-Host "Verifying .env.local..." -ForegroundColor Cyan
Write-Host ""

# 1. Check all required keys exist and are non-empty
$required = @('SUPABASE_URL','SUPABASE_KEY','GEMINI_API_KEY','GROQ_API_KEY','MISTRAL_API_KEY','GITHUB_TOKEN','TAVILY_API_KEY')
foreach ($key in $required) {
    Check "Key present: $key" { $env[$key] -and $env[$key].Length -gt 10 }
}

Write-Host ""

# 2. Verify SUPABASE_URL is DNS-resolvable
Check "DNS resolves: SUPABASE_URL" {
    $url   = $env['SUPABASE_URL'] -replace 'https?://',''
    $url   = $url -replace '/.*',''
    $resolved = [System.Net.Dns]::GetHostAddresses($url)
    $resolved.Count -gt 0
}

# 3. Verify SUPABASE_URL is reachable via HTTP
Check "HTTP reachable: SUPABASE_URL" {
    $url = $env['SUPABASE_URL'] + '/rest/v1/'
    $r   = Invoke-WebRequest -Uri $url -Headers @{apikey=$env['SUPABASE_KEY']} -UseBasicParsing -TimeoutSec 8 -ErrorAction Stop
    $r.StatusCode -lt 500
}

# 4. Verify SUPABASE_KEY JWT contains matching ref
Check "JWT ref matches SUPABASE_URL" {
    $key     = $env['SUPABASE_KEY']
    $payload = $key -split '\.'
    if ($payload.Count -lt 2) { return $false }
    $padded  = $payload[1].PadRight(($payload[1].Length + 3) -band -bnot 3, '=')
    $decoded = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($padded))
    $ref     = ($decoded | ConvertFrom-Json).ref
    $urlRef  = ($env['SUPABASE_URL'] -replace 'https?://','' -split '\.')[0]
    Write-Host "    JWT ref: $ref  |  URL ref: $urlRef" -ForegroundColor DarkGray
    $ref -eq $urlRef
}

# 5. Verify Gemini API key is valid
Check "Gemini API key valid" {
    $r = Invoke-WebRequest -Uri "https://generativelanguage.googleapis.com/v1beta/models?key=$($env['GEMINI_API_KEY'])" -UseBasicParsing -TimeoutSec 8 -ErrorAction Stop
    $r.StatusCode -eq 200
}

Write-Host ""
$color = if ($fail -eq 0) { 'Green' } else { 'Red' }
Write-Host "Result: $pass passed, $fail failed." -ForegroundColor $color
if ($fail -gt 0) {
    Write-Host "Fix the above issues before deploying." -ForegroundColor Yellow
} else {
    Write-Host "All checks passed. Safe to deploy." -ForegroundColor Green
}
Write-Host ""
pause
