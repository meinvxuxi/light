@echo off
REM light - one-click online (Windows + Cloudflare quick tunnel)
REM Requirements: Node.js >=18 and cloudflared.exe on PATH (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
chcp 65001 >nul
cd /d "%~dp0\.."

where node >nul 2>nul
if errorlevel 1 (
  echo [ERR] Node.js not found. Install from https://nodejs.org
  pause & exit /b 1
)
where cloudflared >nul 2>nul
if errorlevel 1 (
  echo [ERR] cloudflared not found. Download it, then add to PATH.
  pause & exit /b 1
)

echo [1/2] Starting game server on port 3000...
start "light-server" cmd /c "set PERSIST_ACHIEVEMENTS=true && set PERSIST_TIMELINE=true && node server.js"
timeout /t 2 /nobreak >nul

echo [2/2] Opening public tunnel - copy the https://...trycloudflare.com link below and share it.
echo After sharing, also give friends the standby page URL like:
echo   https://YOUR-STATIC-HOST/standby.html?srv=https://THAT-TRYCLOUDFLARE-LINK
echo.
cloudflared tunnel --url http://127.0.0.1:3000

echo Server stopped. Closing.
pause
