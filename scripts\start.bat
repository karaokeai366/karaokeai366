@echo off
setlocal
cd /d "%~dp0.."

echo.
echo ========================================
echo          KaraokeAI - Iniciar
echo ========================================
echo.

where docker >nul 2>&1
if errorlevel 1 (
  echo ERRO: Docker nao encontrado no PATH.
  exit /b 1
)

echo Parando qualquer stack Docker anterior...
docker compose down --remove-orphans >nul 2>&1

echo Iniciando o KaraokeAI...
docker compose up -d --build
if errorlevel 1 (
  echo.
  echo ERRO: nao foi possivel iniciar o KaraokeAI.
  echo Execute scripts\logs.bat para investigar.
  exit /b 1
)

echo.
echo Servicos iniciados:
echo   Web:           http://localhost:5173
echo   Signaling:     ws://localhost:8787
echo   Media Worker:  http://localhost:8790
echo.
echo Para outro dispositivo na mesma rede, use o IP deste PC:
echo   http://IP_DO_PC:5173
echo.
echo Use scripts\status.bat para verificar os servicos.
echo.
exit /b 0
