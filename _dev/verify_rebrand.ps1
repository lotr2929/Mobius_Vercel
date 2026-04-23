$root = 'C:\_myProjects\Mobius\Mobius'
$files = Get-ChildItem $root -Recurse -Include '*.js','*.html','*.json','*.bat'
$results = @()
foreach ($f in $files) {
  if ($f.FullName -match '\\chats\\' -or $f.FullName -match '\\node_modules\\') { continue }
  $hits = Select-String -Path $f.FullName -Pattern 'mobius.coder|Mobius_Coder'
  foreach ($h in $hits) {
    $results += "$($f.Name):$($h.LineNumber): $($h.Line.Trim())"
  }
}
if ($results.Count -eq 0) { Write-Host 'CLEAN -- no stray references found.' }
else { $results | ForEach-Object { Write-Host $_ } }
