@echo off
cd /d "%~dp0.."
:loop
call npm run dashboard >> dashboard.log 2>&1
timeout /t 5 /nobreak >nul
goto loop
