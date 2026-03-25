# Mobius Dev Notes

## Known Gotchas

### Beware the em dash ( — )
Claude's text generation sometimes produces em dashes (—) instead of plain hyphens (-).
Em dashes are illegal characters in PowerShell strings and cause a TerminatorExpectedAtEndOfString parse error.
The error message is cryptic and the character is visually hard to spot.

**Rule: always use plain hyphens (-) in all .ps1 files. Never use em dashes.**

Check for em dashes before running any new .ps1 file:
  Select-String -Path .\poll_vercel.ps1 -Pattern "\x{2014}"

