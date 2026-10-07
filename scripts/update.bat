@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

echo.
echo ========================================
echo       KaraokeAI - Atualizar e Iniciar
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

echo [1/5] Verificando Docker Desktop...
docker info >nul 2>&1
if errorlevel 1 (
  echo.
  echo ERRO: Docker Desktop nao esta disponivel.
  echo Abra o Docker Desktop, aguarde ficar Running e execute novamente.
  exit /b 1
)
echo [OK] Docker disponivel.

echo.
echo [2/5] Atualizando codigo...
for /f "delims=" %%H in ('git rev-parse HEAD 2^>nul') do set "OLD_COMMIT=%%H"
git pull --ff-only
if errorlevel 1 (
  echo ERRO: nao foi possivel atualizar o repositorio.
  exit /b 1
)
for /f "delims=" %%H in ('git rev-parse HEAD 2^>nul') do set "NEW_COMMIT=%%H"

if "%OLD_COMMIT%"=="%NEW_COMMIT%" (
  echo [OK] Codigo ja estava atualizado.
  set "CODE_CHANGED=0"
) else (
  echo [OK] Codigo atualizado.
  set "CODE_CHANGED=1"
)

echo.
echo [3/5] Preparando containers...
if "%CODE_CHANGED%"=="1" (
  echo Alteracoes detectadas: reconstruindo imagens...
  docker compose up -d --build
) else (
  echo Nenhuma alteracao no codigo: iniciando containers sem rebuild completo...
  docker compose up -d
)
if errorlevel 1 (
  echo.
  echo ERRO: nao foi possivel iniciar o KaraokeAI.
  echo Execute scripts\logs.bat para investigar.
  exit /b 1
)
echo [OK] Containers iniciados.

echo.
echo [4/5] Verificando servicos...
docker compose ps

echo.
echo Aguardando o Media Worker...
set "HEALTH_OK=0"
for /l %%N in (1,1,20) do (
  curl.exe -fsS http://localhost:8790/health >nul 2>&1
  if not errorlevel 1 (
    set "HEALTH_OK=1"
    goto :health_done
  )
  timeout /t 1 /nobreak >nul
)
:health_done
if "%HEALTH_OK%"=="1" (
  echo [OK] Media Worker respondeu em /health.
) else (
  echo [AVISO] Media Worker ainda nao respondeu em /health.
  echo         Verifique com scripts\status.bat ou scripts\logs.bat.
)

echo.
echo [5/5] Enderecos para teste...
set "LAN_IP="
for /f "delims=" %%I in ('powershell -NoProfile -Command "$x=Get-NetIPAddress -AddressFamily IPv4 ^| Where-Object {$_.IPAddress -notlike ''127.*'' -and $_.IPAddress -notlike ''169.254.*'' -and $_.PrefixOrigin -ne ''WellKnown''} ^| Select-Object -First 1 -ExpandProperty IPAddress; if($x){$x}"') do set "LAN_IP=%%I"

echo.
echo ========================================
echo        KaraokeAI pronto para teste
echo ========================================
echo.
echo PC/Host:
echo   http://localhost:5173
echo.
if defined LAN_IP (
  echo TV e celulares na mesma rede:
  echo   http://%LAN_IP%:5173
) else (
  echo TV e celulares:
  echo   http://IP_DO_PC:5173
)
echo.
echo Para diagnostico:
echo   scripts\status.bat
echo   scripts\logs.bat
echo.
exit /b 0
