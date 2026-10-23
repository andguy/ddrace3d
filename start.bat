@echo off
chcp 65001 >nul
title DDrace 3D
cd /d "%~dp0"
echo.
echo   DDrace 3D - 本地服务器
echo   ----------------------------------------
echo   本机打开:    http://localhost:8117
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do set IP=%%a
echo   局域网朋友:  http://%IP%:8117
echo.
echo   按 Ctrl+C 关闭服务器
echo.
start "" "http://localhost:8117"
python -m http.server 8117 --bind 0.0.0.0
