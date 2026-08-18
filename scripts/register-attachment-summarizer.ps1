<#
.SYNOPSIS
    Register (or refresh) the daily 9 AM Windows Task Scheduler entry for the
    Excel attachment summariser.

.DESCRIPTION
    Creates a scheduled task that runs scripts\run-attachment-summarizer.ps1 once
    a day. Re-running this script updates the existing task rather than
    duplicating it.

    This is a SECOND, independent task alongside CFO-Command-Centre-Agent (the
    hourly pipeline registered by register-scheduler.ps1). They share nothing but
    the project directory: different task name, different runner, different log
    file, so disabling or breaking one leaves the other running.

    Run this ONCE from an ELEVATED PowerShell prompt (Run as Administrator).

.PARAMETER TaskName
    Name of the scheduled task. Default: CFO-Command-Centre-Attachment-Summarizer

.PARAMETER At
    Time of day to run, 24-hour HH:mm. Default: 09:00

.PARAMETER RunAsUser
    Account the task runs as. Defaults to the current user, so it inherits the
    same environment and file permissions the agent works under interactively.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\register-attachment-summarizer.ps1

.EXAMPLE
    # Run at 07:30 instead of 09:00
    powershell -ExecutionPolicy Bypass -File scripts\register-attachment-summarizer.ps1 -At 07:30
#>
param(
    [string]$TaskName = 'CFO-Command-Centre-Attachment-Summarizer',
    [string]$At = '09:00',
    [string]$RunAsUser = "$env:USERDOMAIN\$env:USERNAME"
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $projectRoot 'scripts\run-attachment-summarizer.ps1'

if (-not (Test-Path $runner)) {
    Write-Error "Runner not found: $runner"
    exit 1
}

# Parsed before anything is registered, so a typo'd time fails here rather than
# silently landing the task at midnight.
try {
    $startAt = [datetime]::ParseExact($At, 'HH:mm', $null)
} catch {
    Write-Error "-At must be a 24-hour HH:mm time (e.g. 09:00). Got: '$At'"
    exit 1
}
# Anchor to today's date at that time; Task Scheduler rolls forward on its own.
$startAt = (Get-Date).Date.AddHours($startAt.Hour).AddMinutes($startAt.Minute)

# Elevation is required to register a task for a named user.
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Warning 'Not running as Administrator. Re-run this script from an elevated PowerShell prompt.'
    Write-Warning 'Right-click PowerShell -> "Run as administrator", then run this command again.'
    exit 1
}

Write-Host "Project root : $projectRoot"
Write-Host "Runner       : $runner"
Write-Host "Task name    : $TaskName"
Write-Host "Schedule     : daily at $($startAt.ToString('HH:mm'))"
Write-Host "Run as       : $RunAsUser"
Write-Host ""

# -NoProfile keeps startup deterministic; -ExecutionPolicy Bypass applies to this
# invocation only and does not change the machine policy.
$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $runner) `
    -WorkingDirectory $projectRoot

$trigger = New-ScheduledTaskTrigger -Daily -At $startAt

# StartWhenAvailable matters more here than for the hourly task: this job runs
# once a day, so a machine that was asleep at 09:00 would otherwise skip the day
# entirely rather than catching up.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

# S4U: runs whether or not the user is logged on, without storing a password.
$principal = New-ScheduledTaskPrincipal -UserId $RunAsUser -LogonType S4U -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "Existing task found - updating it."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'Daily Excel attachment summariser. Downloads .xlsx submissions received in the last 24h, reads their contents, and stores a Gemini summary in submissions.attachment_summary. Sends no mail and never writes to the Google Sheet.' | Out-Null

Write-Host ""
Write-Host "[OK] Registered '$TaskName'."
Write-Host "   First run   : $($startAt.ToString('yyyy-MM-dd HH:mm'))"
Write-Host "   Then        : daily at $($startAt.ToString('HH:mm'))"
Write-Host "   Logs        : $projectRoot\logs\attachment-summary-<date>.log"
Write-Host ""
Write-Host "This runs ALONGSIDE the hourly 'CFO-Command-Centre-Agent' task; neither affects the other."
Write-Host ""
Write-Host "Useful commands:"
Write-Host "   Start-ScheduledTask   -TaskName '$TaskName'      # run it now"
Write-Host "   Get-ScheduledTaskInfo -TaskName '$TaskName'      # last run time + result"
Write-Host "   Disable-ScheduledTask -TaskName '$TaskName'      # pause"
Write-Host "   Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false   # remove"
