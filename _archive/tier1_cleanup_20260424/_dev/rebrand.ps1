$root = 'C:\_myProjects\Mobius\Mobius'
$files = Get-ChildItem $root -Recurse -Include '*.js','*.html','*.md','*.json','*.bat','*.ps1','*.txt' |
  Where-Object { $_.FullName -notmatch '\\chats\\' -and $_.FullName -notmatch '\\node_modules\\' }

$count = 0
foreach ($f in $files) {
  $content = [System.IO.File]::ReadAllText($f.FullName)
  $original = $content
  $content = $content -replace 'lotr2929/Mobius_Vercel', 'lotr2929/Mobius_Vercel'
  $content = $content -replace 'mobius\.vercel\.app', 'mobius.vercel.app'
  $content = $content -replace 'mobius-scores', 'mobius-scores'
  $content = $content -replace 'mobius', 'mobius'
  $content = $content -replace 'mobius', 'Mobius'
  $content = $content -replace 'Mobius', 'Mobius'
  $content = $content -replace 'mobius', 'mobius'
  if ($content -ne $original) {
    [System.IO.File]::WriteAllText($f.FullName, $content)
    $count++
    Write-Host "Updated: $($f.Name)"
  }
}
Write-Host "Done. $count files updated."
