<#
.SYNOPSIS
    Unattended daily run of the Excel attachment summariser.

.DESCRIPTION
    Wraps `tsx src/scripts/summarize-attachments.ts` for Windows Task Scheduler,
    mirroring scripts\run-scheduled.ps1:
      * appends timestamped output to logs\attachment-summary-yyyy-MM-dd.log
      * writes an explicit RESULT line so a failed run cannot look like a quiet one
      * exits non-zero on failure so Task Scheduler records it as failed

    Reads and summarises only. It sends no mail and writes nothing to the Google
    Sheet - the only write is submissions.attachment_summary in Postgres - so
    unlike the hourly agent there is no approval gate to enforce here.

    Nobody watches this run, so every exit path writes a verdict to the log.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\run-attachment-summarizer.ps1
#>

$ErrorActionPreference = 'Stop'

# Resolve the project root from this script's own location, so the task works
# regardless of the working directory Task Scheduler happens to start it in.
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$logDir = Join-Path $projectRoot 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$logFile = Join-Path $logDir ("attachment-summary-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
$startedAt = Get-Date

function Write-Log {
    param([string]$Message)
    Add-Content -Path $logFile -Value $Message -Encoding utf8
    Write-Output $Message
}

Write-Log ""
Write-Log "============================================================"
Write-Log ("RUN START  {0}" -f $startedAt.ToString('o'))
Write-Log ("Project    {0}" -f $projectRoot)
Write-Log "============================================================"

$envFile = Join-Path $projectRoot '.env'
if (-not (Test-Path $envFile)) {
    Write-Log "RESULT: FAILED - .env not found at $envFile"
    exit 2
}

# --- Config gate: without a Gemini key every summary comes back null, so the run
# would spend a Gmail attachment download per file to achieve nothing. Refuse
# loudly rather than logging a successful-looking run that changed no data.
$geminiLine = Select-String -Path $envFile -Pattern '^\s*GEMINI_API_KEY\s*=\s*(.+)$' |
    Select-Object -Last 1
$geminiValue = if ($geminiLine) { $geminiLine.Matches[0].Groups[1].Value.Trim().Trim('"').Trim("'") } else { '' }

# CONFIG's realOrEmpty() treats an unfilled "your-..." placeholder as absent, so
# this check has to match that rule or the two would disagree.
if ([string]::IsNullOrWhiteSpace($geminiValue) -or $geminiValue -like 'your-*') {
    Write-Log "RESULT: REFUSED - GEMINI_API_KEY is not set (or still holds the .env.example placeholder)."
    Write-Log "  Nothing can be summarised without it. Set a real key in .env and re-run."
    exit 3
}
Write-Log "GEMINI_API_KEY = present (file contents will be read and summarised)"
Write-Log "SCOPE          = .xlsx attachments on submissions received in the last 24h"
Write-Log ""

# --- Run the summariser. Two deliberate choices, same as run-scheduled.ps1:
#
#   1. tsx is invoked directly rather than via `npm run`, so $LASTEXITCODE is the
#      script's own exit code and not npm's wrapper.
#   2. Streams are merged by cmd, NOT by PowerShell's `2>&1`. PowerShell wraps a
#      native command's stderr in ErrorRecords, which under ErrorActionPreference
#      'Stop' makes an ordinary console.warn abort the whole run. Merging inside
#      cmd hands PowerShell plain text, so the per-file "skipped" warnings this
#      script emits by design stay warnings.
$exitCode = 0
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    & cmd /c 'npx tsx src/scripts/summarize-attachments.ts 2>&1' | ForEach-Object { Write-Log $_ }
    $exitCode = $LASTEXITCODE
} catch {
    Write-Log ("UNCAUGHT ERROR: {0}" -f $_.Exception.Message)
    $exitCode = 1
} finally {
    $ErrorActionPreference = $previousPreference
}

$finishedAt = Get-Date
$duration = [int]($finishedAt - $startedAt).TotalSeconds

Write-Log ""
if ($exitCode -eq 0) {
    Write-Log ("RESULT: SUCCESS  ({0}s)  {1}" -f $duration, $finishedAt.ToString('o'))
} else {
    # Loud and unambiguous: greppable, and Task Scheduler sees the non-zero code.
    Write-Log ("RESULT: FAILED   exit={0}  ({1}s)  {2}" -f $exitCode, $duration, $finishedAt.ToString('o'))
    Write-Log "  The run did NOT complete. Check the output above for the cause"
    Write-Log "  (common: database unreachable, GEMINI_API_KEY missing, Gmail token expired)."
    Write-Log "  Note: individual files that could not be read are reported as Skipped/Failed in"
    Write-Log "  the tally above and do NOT fail the run - they are retried on the next pass."
}
Write-Log "============================================================"

exit $exitCode
