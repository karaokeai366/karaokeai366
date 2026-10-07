@echo off
setlocal
cd /d "%~dp0.."
echo.
echo ========================================
echo          KaraokeAI - Status
echo ========================================
echo.
docker compose ps
echo.
echo Testando portas principais...
powershell -NoProfile -Command "$ports=5173,8787,8790; foreach($p in $ports){$c=Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue; if($c){Write-Host ('Porta '+$p+': OK - PID '+(($c|Select-Object -First 1).OwningProcess))}else{Write-Host ('Porta '+$p+': NAO esta escutando')}}"
echo.
exit /b 0
