@echo off
setlocal
cd /d "%~dp0.."
echo.
echo ========================================
echo           KaraokeAI - Logs
echo ========================================
echo.
docker compose logs --tail=200 -f
