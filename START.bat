@echo off
title AUTOPILOT - keep this window open
cd /d "%~dp0"
if not exist node_modules (
  echo Installing, please wait...
  call npm install
)
set OPEN_BROWSER=1
npm start
echo.
echo AUTOPILOT stopped. Press any key to close.
pause >nul
