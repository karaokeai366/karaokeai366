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

set "LAN_IP="
rem Detecta o IPv4 da rota padrao ativa. Isso evita escolher WSL, Hyper-V,
rem OpenVPN ou outros adaptadores virtuais e funciona mesmo quando
rem Get-NetIPConfiguration nao expõe o gateway como esperado.
for /f "delims=" %%I in ('powershell -NoProfile -Command "$r=Get-NetRoute -AddressFamily IPv4 -DestinationPrefix ''0.0.0.0/0'' -ErrorAction SilentlyContinue ^| Where-Object {$_.NextHop -ne ''0.0.0.0''} ^| Sort-Object RouteMetric,ifMetric ^| Select-Object -First 1; if($r){$a=Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $r.InterfaceIndex -ErrorAction SilentlyContinue ^| Where-Object {$_.IPAddress -notlike ''127.*'' -and $_.IPAddress -notlike ''169.254.*''} ^| Select-Object -First 1; if($a){$a.IPAddress}}"') do set "LAN_IP=%%I"

if not defined LAN_IP (
  echo [AVISO] Rota padrao nao retornou IP. Tentando enderecos privados ativos...
  for /f "delims=" %%I in ('powershell -NoProfile -Command "$a=Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue ^| Where-Object {$_.IPAddress -match ''^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)'' -and $_.IPAddress -notlike ''169.254.*''} ^| Select-Object -First 1; if($a){$a.IPAddress}"') do set "LAN_IP=%%I"
)

if not defined LAN_IP (
  echo [ERRO] Nao foi possivel detectar o IP LAN do PC.
  echo        O KaraokeAI nao sera iniciado para evitar QR Code com 127.0.0.1.
  exit /b 1
)
if "%LAN_IP%"=="127.0.0.1" (
  echo [ERRO] O IP LAN foi detectado como 127.0.0.1.
  echo        O KaraokeAI nao sera iniciado para evitar QR Code invalido.
  exit /b 1
)
set "KARAOKE_LAN_IP=%LAN_IP%"
echo [OK] IP LAN detectado: %LAN_IP%

if not exist ".dev-certs" mkdir ".dev-certs"
set "OLD_LAN_IP="
if exist ".dev-certs\lan-ip.txt" set /p OLD_LAN_IP=<".dev-certs\lan-ip.txt"
if not "%OLD_LAN_IP%"=="%LAN_IP%" (
  del /q ".dev-certs\karaokeai.crt" ".dev-certs\karaokeai.key" >nul 2>&1
  >".dev-certs\lan-ip.txt" echo %LAN_IP%
) else (
  if not exist ".dev-certs\lan-ip.txt" >".dev-certs\lan-ip.txt" echo %LAN_IP%
)
echo [OK] HTTPS LAN preparado em %LAN_IP%

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
echo [5/6] Status automatico...
call scripts\status.bat
if errorlevel 1 (
  echo [AVISO] O status encontrou um problema ao verificar os servicos.
)

echo.
echo [6/6] Enderecos para teste...
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
  echo.
  echo Microfone nos celulares/HTTPS:
  echo   https://%LAN_IP%:5443
) else (
  echo TV e celulares:
  echo   http://IP_DO_PC:5173
  echo   https://IP_DO_PC:5443
)
echo.
echo Para diagnostico:
echo   scripts\status.bat
echo   scripts\logs.bat
echo.
exit /b 0
