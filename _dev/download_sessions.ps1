# download_sessions.ps1 - Downloads Mobius conversation sessions from Supabase
# Called by download_sessions.bat
param(
    [string]$DateFrom = "",
    [string]$DateTo   = ""
)

$SUPABASE_URL = "https://dlbstuzzfmjawffzhdys.supabase.co"
$SUPABASE_KEY = "sb_publishable_nNgdP3DRemXTabvn1ji6zg_xjf1Qbmo"
$USER_ID      = "22008c93-c79b-491d-b3c1-efa194c0c871"

$headers = @{
    "apikey"        = $SUPABASE_KEY
    "Authorization" = "Bearer $SUPABASE_KEY"
    "Content-Type"  = "application/json"
}

# Build date range filter
$fromTs = $DateFrom + "T00:00:00.000Z"
$toTs   = $DateTo   + "T23:59:59.999Z"

$url = "$SUPABASE_URL/rest/v1/conversations" +
    "?user_id=eq.$USER_ID" +
    "&created_at=gte.$fromTs" +
    "&created_at=lte.$toTs" +
    "&order=created_at.asc" +
    "&limit=1000" +
    "&select=created_at,session_id,question,answer,model,ask,instructions,history_count,tokens_in,tokens_out,latency_ms,complexity_score,routing_reason,failed_models,post_flags"

Write-Host "Querying Supabase..."

try {
    $resp = Invoke-RestMethod -Uri $url -Headers $headers -Method Get -ErrorAction Stop
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

if ($resp.Count -eq 0) {
    Write-Host "No conversations found between $DateFrom and $DateTo." -ForegroundColor Yellow
    exit 0
}

Write-Host "Found $($resp.Count) exchanges. Building log..." -ForegroundColor Green

# Group by session_id
$sessions = @{}
$sessionOrder = [System.Collections.Generic.List[string]]::new()

foreach ($row in $resp) {
    $sid = if ($row.session_id) { $row.session_id } else { "no-session" }
    if (-not $sessions.ContainsKey($sid)) {
        $sessions[$sid] = [System.Collections.Generic.List[object]]::new()
        $sessionOrder.Add($sid)
    }
    $sessions[$sid].Add($row)
}

# Build output text
$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add("MOBIUS SESSION LOG")
$lines.Add("Period: $DateFrom to $DateTo")
$lines.Add("Downloaded: $(Get-Date -Format 'dd MMM yyyy HH:mm')")
$lines.Add("Total exchanges: $($resp.Count)  |  Sessions: $($sessionOrder.Count)")
$lines.Add("=" * 60)
$lines.Add("")

$exchNum = 1
foreach ($sid in $sessionOrder) {
    $msgs = $sessions[$sid]
    $lines.Add("SESSION: $sid")
    $lines.Add("Started: $($msgs[0].created_at)")
    $lines.Add("-" * 60)

    foreach ($m in $msgs) {
        $lines.Add("[Exchange $exchNum]  $(([datetime]$m.created_at).ToLocalTime().ToString('HH:mm:ss'))")

        $lines.Add("Q: $($m.question)")

        # Mobius query block
        $askLine = "ASK: $($m.ask)"
        if ($m.instructions) { $askLine += "  |  INSTRUCTIONS: $($m.instructions)" }
        if ($null -ne $m.history_count) { $askLine += "  |  HISTORY: [$($m.history_count)]" }
        $lines.Add($askLine)

        # Routing
        if ($m.routing_reason) { $lines.Add("ROUTING: $($m.routing_reason)") }
        if ($m.complexity_score -ne $null) { $lines.Add("COMPLEXITY SCORE: $($m.complexity_score)") }

        # Model
        $modelLine = "MODEL: $($m.model)"
        if ($m.latency_ms) { $modelLine += "  |  $($m.latency_ms)ms" }
        if ($m.tokens_in -or $m.tokens_out) { $modelLine += "  |  $($m.tokens_in) in / $($m.tokens_out) out tokens" }
        $lines.Add($modelLine)

        # Fallbacks
        if ($m.failed_models -and $m.failed_models.Count -gt 0) {
            $fb = ($m.failed_models | ForEach-Object { "$($_.model) - $($_.reason)" }) -join " | "
            $lines.Add("FALLBACKS: $fb")
        }

        # Flags
        if ($m.post_flags -and $m.post_flags.Count -gt 0) {
            $lines.Add("FLAGS: $($m.post_flags -join ' | ')")
        }

        $lines.Add("A: $($m.answer)")
        $lines.Add("-" * 60)
        $lines.Add("")
        $exchNum++
    }
    $lines.Add("")
}

# Write output file
$outFile = "sessions-$DateFrom-to-$DateTo.txt"
$lines | Out-File -FilePath $outFile -Encoding utf8

Write-Host ""
Write-Host "Saved to: $outFile" -ForegroundColor Green
Write-Host "You can now paste the contents into Claude for discussion."
