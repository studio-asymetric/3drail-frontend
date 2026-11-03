@echo off
setlocal
cd /d "%~dp0\.."
echo.
echo ================================
echo Starting 3D Railmap proxy server
echo Listening on http://localhost:3001
echo Press Ctrl+C to stop.
echo ================================
node proxy/server.mjs
endlocal



