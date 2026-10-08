param(
  [string]$LanIp = ""
)

$ErrorActionPreference = "Stop"

if (-not $LanIp) {
  $LanIp = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
      $_.IPAddress -notlike "127.*" -and
      $_.IPAddress -notlike "169.254.*" -and
      $_.PrefixOrigin -ne "WellKnown"
    } |
    Select-Object -First 1 -ExpandProperty IPAddress)
}

if (-not $LanIp) { throw "Nao foi possivel detectar o IP da LAN. Informe: .\scripts\setup-local-https.ps1 -LanIp 192.168.x.x" }

if (-not (Get-Command mkcert -ErrorAction SilentlyContinue)) {
  throw "mkcert nao encontrado. Instale o mkcert e execute novamente. O mkcert instala uma CA local confiavel no Windows."
}

New-Item -ItemType Directory -Force -Path ".dev-certs" | Out-Null

mkcert -install
mkcert -cert-file ".dev-certs/karaokeai.crt" -key-file ".dev-certs/karaokeai.key" "localhost" "karaokeai.local" "127.0.0.1" "::1" $LanIp

Write-Host ""
Write-Host "Certificado local criado para $LanIp."
Write-Host "A CA do mkcert foi instalada como confiavel no Windows."
Write-Host "Para Android/TV, instale a CA raiz do mkcert nesses dispositivos antes do teste."
Write-Host "Consulte o caminho com: mkcert -CAROOT"
