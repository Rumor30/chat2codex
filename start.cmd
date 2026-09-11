@echo off
cd /d "%~dp0"
node src/cli.mjs start
if errorlevel 1 pause
