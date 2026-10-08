                    <span>🎵 Afinação {lastCompleted.score.pitch}</span>
                    <span>🥁 Ritmo {lastCompleted.score.rhythm}</span>
                    <span>🎯 Precisão {lastCompleted.score.precision}</span>
                    <span>〽️ Estabilidade {lastCompleted.score.stability}</span>
                  </div>
                </div>
              )}

              {latestRoundResult?.result.finished && (
                <div className="tv-round-final">
                  <span className="eyebrow">🏁 RODADA CONCLUÍDA</span>
                  <div className="tv-result-singer">
                    🎙️ {latestRoundResult.participant?.name ?? 'Participante'}
                  </div>
                  <strong>{latestRoundResult.result.score ?? 0}<small>/100</small></strong>
                  <p>
                    {latestRoundResult.result.completedSongs} de {latestRoundResult.result.requiredSongs ?? latestRoundResult.result.completedSongs} músicas oficiais concluídas.
                  </p>
                  <div className="tv-round-songs">
                    {latestRoundResult.result.songScores.map((item, index) => (
                      <span key={item.queueEntryId}>Música {index + 1}: <strong>{item.score}</strong></span>
                    ))}
                  </div>
                </div>
              )}

              {roundResults.length > 1 && (
                <div className="tv-round-participants">
                  <span className="eyebrow">OUTRAS CONCLUSÕES</span>
                  {roundResults.slice(1).filter((item) => item.result.finished).map((item) => (
                    <div className="tv-round-participant" key={item.participantId}>
                      <span>🎙️ {item.participant?.name ?? 'Participante'}</span>
                      <strong>{item.result.score ?? 0}/100</strong>
                    </div>
                  ))}
                </div>
              )}

              {latestRoundResult?.result && !latestRoundResult.result.finished && latestRoundResult.result.completedSongs > 0 && (
                <div className="tv-round-progress">
                  <span className="eyebrow">🎯 RODADA</span>
                  <strong>{latestRoundResult.result.completedSongs}{latestRoundResult.result.requiredSongs ? ` / ${latestRoundResult.result.requiredSongs}` : ''}</strong>
                  {latestRoundResult.result.score !== undefined && <small>Média atual: {latestRoundResult.result.score}/100</small>}
                </div>
              )}

              {!playing && audioEnabled && <span className="tv-audio-ready">🔊 Áudio pronto</span>}
              {!playing && (
                <StagePlaybackControls
                  session={session}
                  participantId={participantId}
                  transport={transport}
                  compact
                />
              )}
            </div>
          )}
        </div>

        <aside className="tv-queue">
          <div className="tv-queue-heading"><span className="eyebrow">FILA</span><strong>{upcoming.length}</strong></div>
          {nextEntry && (
            <div className="tv-next-singer">
              <span className="eyebrow">PRÓXIMO CANTOR</span>
              <strong>🎙️ {nextOwner?.name ?? 'Participante'}</strong>
              <span>{nextEntry.title}</span>
              <small className={nextEntry.status === 'ready' ? 'next-ready' : ''}>
                {nextEntry.status === 'ready' ? '✓ PRONTO PARA O PALCO' : '⏳ preparando'}
              </small>
            </div>
          )}
          {upcoming.slice(0, 6).map((entry, index) => (
            <div className={`tv-queue-row ${entry.status === 'playing' ? 'active' : ''}`} key={entry.id}>
              <span>{index + 1}</span>
              <div className="tv-queue-thumb">{entry.thumbnailUrl ? <img src={entry.thumbnailUrl} alt="" /> : '🎵'}</div>
              <div><strong>{entry.title}</strong><small>{entry.artist ?? 'Artista não informado'}</small></div>
            </div>
          ))}
        </aside>
      </section>
    </main>
    </>