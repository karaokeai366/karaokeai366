# Áudio multi-participante em uma apresentação

Uma apresentação do KaraokeAI possui um **cantor principal** e pode receber participantes convidados de áudio.

## Modelo

- `primary`: dono da música e único participante com scoring oficial.
- `guest`: contribui com microfone, mas não recebe scoring oficial.
- O Host e o cantor principal podem adicionar/remover convidados.
- O cantor principal nunca pode ser removido.
- Cada convidado pode ativar/desativar o próprio microfone durante a apresentação.
- O estado fica associado ao `queueEntryId` e ao `activePerformanceId`, evitando misturar sinais entre músicas.

## Capacidade

O limite técnico inicial é configurável por `MAX_PERFORMANCE_CONTRIBUTORS`, com padrão de 8 e máximo de 16. Isso é independente da capacidade da festa de até 50 participantes.

Esse limite é deliberado: a sessão pode ter 50 celulares, mas não significa que todos devam abrir microfone simultaneamente na mesma apresentação.

## Transporte

O estado de áudio já possui `transport`:

- `webrtc`: transporte atual/fundação.
- `sfu`: reservado para uma futura camada SFU sem alterar o contrato da sessão.

A sinalização `performance.audio.*` é validada pelo servidor e só pode circular entre participantes ativos da apresentação (ou TV como destino de sinalização).

## Scoring

O contrato separa participação de áudio de pontuação:

- somente `primary` inicia com `scoringEnabled=true`;
- convidados entram com `scoringEnabled=false`;
- o payload de scoring continua vinculado ao dono da música.

Isso permite evoluir posteriormente para modos como dueto, coro ou pontuação por participante sem quebrar a apresentação básica.

## Fluxo

1. servidor inicia a música e cria `performanceId`;
2. cantor principal é registrado como `primary`;
3. Host/cantor adiciona convidados;
4. servidor publica `performance.participant.added`;
5. convidados estabelecem áudio através da sinalização `performance.audio.*`;
6. cada participante pode alterar seu estado de microfone;
7. ao remover um convidado, o servidor publica `performance.participant.removed`;
8. ao terminar a música, a identidade da performance deixa de ser reutilizável.

A implementação mantém a separação entre **estado da apresentação**, **controle de participação** e **transporte de áudio**. Assim, a futura adoção de SFU não exige redesenhar a sessão.
