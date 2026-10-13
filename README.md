# KaraokeAI 🎤

Plataforma de karaokê local para usar o computador como Host, uma TV como palco e celulares como participantes. O projeto está em desenvolvimento; o CI valida compilação e testes automatizados, mas isso não substitui os testes com aparelhos reais.

## O que já existe

- Aplicação Web/PWA única com modos de Host, participante e TV.
- Criação e entrada em sessão por link/QR Code, com sincronização de participantes e estado.
- Sinalização em tempo real, reconexão e recuperação do estado da sessão.
- Fila compartilhada de músicas, controle de reprodução e organização do próximo cantor.
- Serviço de preparação de mídia, com download/processamento e separação de voz e instrumental.
- Biblioteca permanente de músicas preparadas, independente da sessão, armazenada em volume Docker.
- Exibição dos nomes das notas musicais em português (Dó, Ré, Mi, Fá, Sol, Lá e Si).
- Verificações automáticas de compilação e smoke test do signaling.

**Importante:** nem tudo que foi planejado está concluído ou validado em aparelhos reais. A interface nativa separada para Android/iOS/TV não existe: os dispositivos usam a mesma aplicação Web/PWA. Compatibilidade de navegadores de TV, áudio/WebRTC, cancelamento durante processamento e desempenho devem continuar sendo testados no ambiente real.

## Executar os serviços no Windows

A forma recomendada para o ambiente de teste é usar o Docker Compose. Não é necessário iniciar três serviços manualmente no VS Code.

### 1. Pré-requisitos

- Git.
- Docker Desktop instalado e em execução.
- `mkcert` instalado para gerar o certificado HTTPS local.

Clone o repositório e entre na pasta do projeto. Na primeira execução, abra o PowerShell **na raiz do repositório** e gere o certificado para o IP atual do computador:

```powershell
.\scripts\setup-local-https.ps1
```

Se o IP da rede não for detectado automaticamente, informe-o explicitamente:

```powershell
.\scripts\setup-local-https.ps1 -LanIp 192.168.1.100
```

Substitua o exemplo pelo IP real do PC. Para usar microfone no celular, abra a aplicação pelo HTTPS. Celulares e TVs podem exigir que a autoridade certificadora local do `mkcert` seja instalada/confiada no próprio dispositivo.

### 2. Iniciar ou atualizar

Na raiz do repositório, execute:

```bat
scripts\update.bat
```

Esse comando atualiza o código da branch `main`, prepara/inicia os containers e mostra o estado dos serviços. Para apenas iniciar a stack sem atualizar o código, use `scripts\start.bat`.

### 3. Endereços

Use o IP LAN do computador no lugar de `IP_DO_PC` quando acessar de outro dispositivo.

| Serviço | Endereço/porta | Uso |
|---|---|---|
| Web local HTTP | `http://localhost:5173` | Diagnóstico no PC |
| Web HTTPS | `https://IP_DO_PC:5443` | Host, celular e TV; preferido para liberar o microfone |
| Signaling | `8787` | Comunicação das sessões; iniciado pelo Docker |
| Media Worker | `8790` | Preparação de mídia e endpoint de saúde; iniciado pelo Docker |

Abra o Host pelo endereço HTTPS. O QR Code deve levar os celulares/TV ao endereço HTTPS do PC. Os dispositivos precisam conseguir se comunicar pela rede local; isolamento de clientes Wi-Fi ou regras de firewall podem impedir a conexão.

### 4. Comandos úteis

Execute na raiz do projeto:

| Arquivo | Ação |
|---|---|
| `scripts\status.bat` | Verifica containers e portas |
| `scripts\logs.bat` | Acompanha os logs dos serviços |
| `scripts\restart.bat` | Reinicia os serviços |
| `scripts\stop.bat` | Para os serviços, preservando os volumes de mídia e modelos |
| `scripts\test.bat` | Executa verificações internas disponíveis |

A biblioteca de músicas preparadas e os modelos ficam em volumes Docker. Parar a stack com `scripts\stop.bat` não apaga esses volumes.

## Desenvolvimento e validação

A aplicação Web está em `apps/web`, o servidor de sessões em `apps/signaling` e o serviço de mídia em `apps/media-worker`. O modo Docker acima é o caminho recomendado para testar os três integrados.

O CI verifica o typecheck/build da Web, build e smoke test do signaling e compilação/testes unitários do Media Worker. Antes de considerar uma versão pronta, ainda é necessário testar no mínimo PC + celular + TV, incluindo entrada/reconexão, fila, reprodução, microfone/áudio, cancelamento de música e preparação da próxima faixa.
