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

if not exist ".dev-certs" mkdir ".dev-certs"

rem Detecta o IPv4 em um script PowerShell separado para evitar
rem qualquer conflito de aspas ou caracteres especiais do CMD.
> ".dev-certs\\detect-lan-ip.ps1" echo $cfg = Get-NetIPConfiguration
>> ".dev-certs\\detect-lan-ip.ps1" echo foreach ($c in $cfg) {
>> ".dev-certs\\detect-lan-ip.ps1" echo   if ($c.NetAdapter.Status -eq "Up" -and $null -ne $c.IPv4DefaultGateway -and $null -ne $c.IPv4Address) {
>> ".dev-certs\\detect-lan-ip.ps1" echo     foreach ($a in @($c.IPv4Address)) {
>> ".dev-certs\\detect-lan-ip.ps1" echo       $ip = $a.IPAddress
>> ".dev-certs\\detect-lan-ip.ps1" echo       if ($ip -and $ip -notlike "127.*" -and $ip -notlike "169.254.*") { Write-Output $ip; exit }
>> ".dev-certs\\detect-lan-ip.ps1" echo     }
>> ".dev-certs\\detect-lan-ip.ps1" echo   }
>> ".dev-certs\\detect-lan-ip.ps1" echo }
>> ".dev-certs\\detect-lan-ip.ps1" echo $addrs = Get-NetIPAddress -AddressFamily IPv4
>> ".dev-certs\\detect-lan-ip.ps1" echo foreach ($a in $addrs) {
>> ".dev-certs\\detect-lan-ip.ps1" echo   $ip = $a.IPAddress
>> ".dev-certs\\detect-lan-ip.ps1" echo   if ($ip -like "192.168.*" -or $ip -like "10.*" -or $ip -like "172.16.*" -or $ip -like "172.17.*" -or $ip -like "172.18.*" -or $ip -like "172.19.*" -or $ip -like "172.2*.*" -or $ip -like "172.3*.*") { Write-Output $ip; exit }
>> ".dev-certs\\detect-lan-ip.ps1" echo }
powershell -NoProfile -ExecutionPolicy Bypass -File ".dev-certs\\detect-lan-ip.ps1" > ".dev-certs\\detected-lan-ip.txt" 2>nul


if not defined LAN_IP (
  echo [ERRO] Nao foi possivel detectar o IP LAN do PC.
  echo        O KaraokeAI nao sera iniciado.
  exit /b 1
)
if "%LAN_IP%"=="127.0.0.1" (
  echo [ERRO] IP LAN invalido: 127.0.0.1
  echo        O KaraokeAI nao sera iniciado.
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
if defined LAN_IP (
  echo PC/Host - use este endereco:
  echo   https://%LAN_IP%:5443
  echo.
  echo TV e celulares na mesma rede:
  echo   https://%LAN_IP%:5443
  echo.
  echo HTTP local - apenas diagnostico:
  echo   http://localhost:5173
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
