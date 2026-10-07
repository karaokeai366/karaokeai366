@echo off
setlocal
cd /d "%~dp0.."

echo.
echo ========================================
echo           KaraokeAI - Parar
echo ========================================
echo.

docker compose down --remove-orphans
if errorlevel 1 (
  echo ERRO ao parar a stack.
  exit /b 1
)

echo.
echo KaraokeAI parado. Os volumes de media e modelos foram preservados.
echo.
exit /b 0
