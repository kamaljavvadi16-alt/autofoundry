@echo off
cd /d %~dp0

rem If AutoFoundry is already running, switch its daemon on and just open the dashboard.
powershell -NoProfile -Command "try { Invoke-RestMethod -Method Post -Uri http://localhost:4321/api/control -ContentType 'application/json' -Body '{\"action\":\"daemon_start\"}' | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel%==0 (
  echo AutoFoundry is already running - opening the dashboard...
  start "" http://localhost:4321
  timeout /t 3 >nul
  exit /b 0
)

echo Starting AutoFoundry - keep this window open. Closing it turns AutoFoundry off.
start "" http://localhost:4321
npm run --silent foundry -- serve -p 4321 --daemon

echo.
echo AutoFoundry has stopped. If that was unexpected, read any error above.
pause >nul
