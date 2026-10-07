@echo off
setlocal
cd /d "%~dp0.."

echo.
echo ========================================
echo        KaraokeAI - Atualizacao
echo ========================================
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo ERRO: Git nao encontrado no PATH.
  exit /b 1
)

where docker >nul 2>&1
if errorlevel 1 (
  echo ERRO: Docker nao encontrado no PATH.
  exit /b 1
)

echo [1/3] Atualizando codigo...
git pull --ff-only
if errorlevel 1 (
  echo ERRO: nao foi possivel atualizar o repositorio.
  exit /b 1
)

echo.
echo [2/3] Reconstruindo imagens...
docker compose build
if errorlevel 1 (
  echo ERRO: falha na construcao das imagens.
  exit /b 1
)

echo.
echo [3/3] Atualizacao concluida.
echo Use scripts\start.bat para iniciar o KaraokeAI.
echo.
exit /b 0
