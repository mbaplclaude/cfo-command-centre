<#
.SYNOPSIS
    Unattended hourly run of the CFO Command Centre agent.

.DESCRIPTION
    Wraps `tsx src/agent.ts` for Windows Task Scheduler:
      * refuses to run unless REQUIRE_APPROVAL is true (never automates SENDING)
      * appends timestamped output to logs\agent-yyyy-MM-dd.log
      * writes an explicit RESULT line so a failed run cannot look like a quiet one
      * exits non-zero on failure so Task Scheduler records it as failed

    Nobody watches this run, so every exit path writes a verdict to the log.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\run-scheduled.ps1
#>

$ErrorActionPreference = 'Stop'

# Resolve the project root from this script's own location, so the task works
# regardless of the working directory Task Scheduler happens to start it in.
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$logDir = Join-Path $projectRoot 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

$logFile = Join-Path $logDir ("agent-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
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

# --- Safety gate: the scheduler automates checking and drafting, never sending.
$envFile = Join-Path $projectRoot '.env'
if (-not (Test-Path $envFile)) {
    Write-Log "RESULT: FAILED - .env not found at $envFile"
    exit 2
}

$requireApproval = Select-String -Path $envFile -Pattern '^\s*REQUIRE_APPROVAL\s*=\s*(.+)$' |
    Select-Object -Last 1
$approvalValue = if ($requireApproval) { $requireApproval.Matches[0].Groups[1].Value.Trim() } else { '' }

# CONFIG treats anything other than the literal "false" as true, so only an
# explicit false is a problem.
if ($approvalValue -eq 'false') {
    Write-Log "RESULT: REFUSED - REQUIRE_APPROVAL=false in .env."
    Write-Log "  The scheduler must never send reminders unattended. Set REQUIRE_APPROVAL=true"
    Write-Log "  and approve runs manually via the dashboard or: npm run agent -- --approve <RUN_ID>"
    exit 3
}
Write-Log ("REQUIRE_APPROVAL = {0} (drafting only; sending still needs your approval)" -f $(if ($approvalValue) { $approvalValue } else { 'true (default)' }))
Write-Log "SCOPE            = 4. Report Calendar only (Staff Tracker is sent manually from the dashboard)"
Write-Log ""

# --- Run the pipeline. Two deliberate choices here:
#
#   1. tsx is invoked directly rather than via `npm run`, so $LASTEXITCODE is the
#      agent's own exit code and not npm's wrapper.
#   2. Streams are merged by cmd, NOT by PowerShell's `2>&1`. PowerShell wraps a
#      native command's stderr in ErrorRecords, which under ErrorActionPreference
#      'Stop' makes an ordinary console.warn abort the whole run. Merging inside
#      cmd hands PowerShell plain text, so warnings stay warnings.
$exitCode = 0
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
    # --reports-only: the scheduled run covers "4. Report Calendar" exclusively.
    # Staff Tracker reminders are reviewed and sent by hand from the dashboard.
    & cmd /c 'npx tsx src/agent.ts --reports-only 2>&1' | ForEach-Object { Write-Log $_ }
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
    Write-Log "  The run did NOT complete. Nothing was sent. Check the output above for the cause"
    Write-Log "  (common: database unreachable, Gmail API error, Google Sheets permission)."
}
Write-Log "============================================================"

exit $exitCode
