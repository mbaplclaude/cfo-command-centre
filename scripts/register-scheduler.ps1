<#
.SYNOPSIS
    Register (or refresh) the hourly Windows Task Scheduler entry for the agent.

.DESCRIPTION
    Creates a scheduled task that runs scripts\run-scheduled.ps1 every hour.
    Re-running this script updates the existing task rather than duplicating it.

    Run this ONCE from an ELEVATED PowerShell prompt (Run as Administrator).

.PARAMETER TaskName
    Name of the scheduled task. Default: CFO-Command-Centre-Agent

.PARAMETER IntervalHours
    How often to run, in hours. Default: 1

.PARAMETER RunAsUser
    Account the task runs as. Defaults to the current user, so it inherits the
    same environment and file permissions the agent works under interactively.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\register-scheduler.ps1

.EXAMPLE
    # Every 2 hours instead of hourly
    powershell -ExecutionPolicy Bypass -File scripts\register-scheduler.ps1 -IntervalHours 2
#>
param(
    [string]$TaskName = 'CFO-Command-Centre-Agent',
    [int]$IntervalHours = 1,
    [string]$RunAsUser = "$env:USERDOMAIN\$env:USERNAME"
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $projectRoot 'scripts\run-scheduled.ps1'

if (-not (Test-Path $runner)) {
    Write-Error "Runner not found: $runner"
    exit 1
}

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
Write-Host "Interval     : every $IntervalHours hour(s)"
Write-Host "Run as       : $RunAsUser"
Write-Host ""

# -NoProfile keeps startup deterministic; -ExecutionPolicy Bypass applies to this
# invocation only and does not change the machine policy.
$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $runner) `
    -WorkingDirectory $projectRoot

# Start at the next whole hour, then repeat indefinitely.
$startAt = (Get-Date).Date.AddHours((Get-Date).Hour + 1)
$trigger = New-ScheduledTaskTrigger -Once -At $startAt `
    -RepetitionInterval (New-TimeSpan -Hours $IntervalHours)

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
    -Description 'Hourly CFO Command Centre agent run. Reads Sheets + Gmail, classifies submissions, drafts reminders. Never sends without manual approval (REQUIRE_APPROVAL=true).' | Out-Null

Write-Host ""
Write-Host "[OK] Registered '$TaskName'."
Write-Host "   First run   : $($startAt.ToString('yyyy-MM-dd HH:mm'))"
Write-Host "   Then        : every $IntervalHours hour(s)"
Write-Host "   Logs        : $projectRoot\logs\agent-<date>.log"
Write-Host ""
Write-Host "Useful commands:"
Write-Host "   Start-ScheduledTask   -TaskName '$TaskName'      # run it now"
Write-Host "   Get-ScheduledTaskInfo -TaskName '$TaskName'      # last run time + result"
Write-Host "   Disable-ScheduledTask -TaskName '$TaskName'      # pause"
Write-Host "   Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false   # remove"
