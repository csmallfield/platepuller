@echo off
rem Double-click to start the platepuller UI. Closing this window stops it.
title platepuller
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
where ffmpeg >nul 2>nul || echo Warning: ffmpeg was not found on PATH. Install it with: winget install Gyan.FFmpeg
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund || (pause & exit /b 1)
)
if not exist .venv (
  echo Setting up optional OpenEXR and OpenColorIO support ^(DWAA/DWAB/PIZ, ACES view^)...
  node scripts\setup-exr.js --quiet
)
node src\ui\server.js --open %*
if errorlevel 1 pause
