@echo off
title Grok Bot
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required. Install it from https://nodejs.org then run this file again.
  pause
  exit /b 1
)
node scripts\serve.mjs 8080 --open
pause
