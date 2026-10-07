@echo off
setlocal
cd /d "%~dp0.."

echo.
echo ========================================
echo        KaraokeAI - Testes internos
echo ========================================
echo.

docker compose run --rm --no-deps signaling sh -lc "npm install && npm run build && npm run smoke"
if errorlevel 1 (
  echo.
  echo FALHA no smoke test do Signaling.
  exit /b 1
)

echo.
echo Verificando Media Worker...
docker compose run --rm --no-deps media-worker python -m compileall -q src
if errorlevel 1 (
  echo.
  echo FALHA no compile check do Media Worker.
  exit /b 1
)

echo.
echo Testes internos concluidos.
exit /b 0
