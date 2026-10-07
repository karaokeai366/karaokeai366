@echo off
setlocal
cd /d "%~dp0.."
echo.
echo ========================================
echo          KaraokeAI - Iniciar
echo ========================================
echo.
where docker >nul 2>&1
if errorlevel 1 (echo ERRO: Docker nao encontrado no PATH.& exit /b 1)

set "LAN_IP="
for /f "delims=" %%I in ('powershell -NoProfile -Command "$x=Get-NetIPAddress -AddressFamily IPv4 ^| Where-Object {$_.IPAddress -notlike ''127.*'' -and $_.IPAddress -notlike ''169.254.*'' -and $_.PrefixOrigin -ne ''WellKnown''} ^| Select-Object -First 1 -ExpandProperty IPAddress; if($x){$x}"') do set "LAN_IP=%%I"
if not defined LAN_IP set "LAN_IP=127.0.0.1"
set "KARAOKE_LAN_IP=%LAN_IP%"
if not exist ".dev-certs" mkdir ".dev-certs"
set "OLD_LAN_IP="
if exist ".dev-certs\lan-ip.txt" set /p OLD_LAN_IP=<".dev-certs\lan-ip.txt"
if not "%OLD_LAN_IP%"=="%LAN_IP%" (
  del /q ".dev-certs\karaokeai.crt" ".dev-certs\karaokeai.key" >nul 2>&1
  >".dev-certs\lan-ip.txt" echo %LAN_IP%
) else (
  if not exist ".dev-certs\lan-ip.txt" >".dev-certs\lan-ip.txt" echo %LAN_IP%
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
echo   Web HTTP local: http://localhost:5173
echo   Web HTTPS:     https://localhost:5443
echo   Signaling:     ws://localhost:8787
echo   Media Worker:  interno via /media-worker
echo.
echo PC/Host e dispositivos da rede:
echo   HTTPS:         https://%LAN_IP%:5443
echo.
echo IMPORTANTE: abra o Host pelo endereco HTTPS acima.
echo O QR Code usa esse mesmo endereco da rede.
echo.
echo No celular, use o endereco HTTPS para liberar o microfone.
echo O navegador podera pedir confirmacao para o certificado local na primeira vez.
echo.
echo Use scripts\status.bat para verificar os servicos.
echo.
exit /b 0
