@echo off
title AUTOPILOT (PC copy)
cd /d "%~dp0"
echo.
echo  AUTOPILOT now runs ONLINE: https://autopilot-cndt.onrender.com
echo  This PC copy is retired. Running both at once can double-launch or double-sell.
echo.
set /p ok=Type YES to start the PC copy anyway: 
if /I not "%ok%"=="YES" exit /b
if not exist node_modules (
  echo Installing, please wait...
  call npm install
)
set OPEN_BROWSER=1
npm start
echo.
echo AUTOPILOT stopped. Press any key to close.
pause >nul
