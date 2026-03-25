# Mobius Dev Notes

## Debugging Methodology

When something doesn't work, follow this order — do not skip steps:

1. **Start with the obvious**
   Check the most likely cause first: syntax errors, typos, missing files,
   wrong values. Don't assume the obvious is fine just because it looks fine.

2. **Check the protocols**
   Have the APIs, endpoints, or service behaviours changed since last time?
   Read the current docs. Don't assume what worked before still works.

3. **Check for "human" errors**
   If the logic seems correct but results are wrong, look for silent mistakes:
   - Wrong project ID, wrong credentials, wrong environment
   - Special characters that look correct but aren't (e.g. em dash vs hyphen)
   - Files saved to the wrong location
   - Cached/stale values from a previous run

4. **Step through the code**
   If none of the above, isolate and test each step individually.
   Don't run the full script — break it into pieces and verify each one.
   Build diagnostic scripts (like poll_test.ps1) that stay open and show
   exactly what is being returned at each step.

**The key rule: if the first few attempts don't yield results, stop and
question your assumptions. Something you believe is correct probably isn't.**

---

## Known Gotchas

### Beware the em dash ( - )
Claude's text generation sometimes produces em dashes (-) instead of plain hyphens (-).
Em dashes are illegal characters in PowerShell strings and cause a
TerminatorExpectedAtEndOfString parse error. The error message is cryptic
and the character is visually hard to spot.

**Rule: always use plain hyphens (-) in all .ps1 files. Never use em dashes.**

Check for em dashes before running any new .ps1 file:
  Select-String -Path .\poll_vercel.ps1 -Pattern "\x{2014}"

### Verify configuration before debugging logic
When polling or API calls behave unexpectedly, verify the target first:
  - Are credentials pointing to the right project?
  - Run poll_test.ps1 to list all projects and confirm IDs match deploy.env
  - In this case: deploy.env had prj_TuLa8NVgIa3jq8TNKAT4LlmUGh3d (mobius)
    instead of prj_9CppPeNBf9Tj6P7FEucVlYCZXPwf (mobius-vercel), causing
    hours of wasted debugging because the logic was debugged instead of the
    configuration.

---

## Recommended Reading on Debugging

The classic reference is **"Debugging: The 9 Indispensable Rules for Finding
Even the Most Elusive Software and Hardware Problems"** by David J. Agans (2002).
The nine rules are:

1. Understand the system
2. Make it fail (reproduce the problem)
3. Quit thinking and look (observe, don't guess)
4. Divide and conquer (narrow down the location)
5. Change one thing at a time
6. Keep an audit trail (write down what you did)
7. Check the plug (verify the obvious)
8. Get a fresh view (ask someone else)
9. If you didn't fix it, it ain't fixed (verify the fix actually worked)

Agans' Rule 7 ("Check the plug") and Rule 3 ("Quit thinking and look") are
exactly what was violated in the deploy.bat debugging session above.

Another good reference: **"The Pragmatic Programmer"** by Hunt & Thomas has
a chapter on debugging with similar principles — notably "select isn't broken",
meaning the bug is almost always in your code/config, not the tool.
