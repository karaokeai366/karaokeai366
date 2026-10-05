import { WebSocket } from 'ws';

const port = Number(process.env.PORT ?? 8787);
const url = `ws://127.0.0.1:${port}`;
const sessionId = `smoke-${Date.now()}`;
const soloSessionId = `smoke-solo-${Date.now()}`;
const handoverSessionId = `smoke-handover-${Date.now()}`;
const TIMEOUT = 15000;

function client(senderId, clientSessionId = sessionId) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];

  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiter.resolve(message);
        waiters.splice(waiters.indexOf(waiter), 1);
      }
    }
  });

  const waitOpen = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout opening ${senderId}`)), TIMEOUT);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', error => { clearTimeout(timer); reject(error); });
  });

  return {
    ws,
    senderId,
    messages,
    waitOpen,
    waitFor(predicate, timeout = TIMEOUT) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex(item => item.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timeout waiting for ${senderId}`));
        }, timeout);
        waiters.push({
          predicate,
          resolve: value => { clearTimeout(timer); resolve(value); }
        });
      });
    },
    send(type, payload = {}) {
      ws.send(JSON.stringify({
        id: crypto.randomUUID(),
        type,
        sessionId: clientSessionId,
        senderId,
        timestamp: Date.now(),
        payload
      }));
    }
  };
}

async function openClients(clients, batchSize = 10) {
  for (let index = 0; index < clients.length; index += batchSize) {
    await Promise.all(clients.slice(index, index + batchSize).map(c => c.waitOpen));
  }
}

const host = client('smoke-host');
const singer = client('smoke-singer');
const tv = client('smoke-tv');
const overflow = client('smoke-overflow');
const soloHost = client('smoke-solo-host', soloSessionId);
const soloSinger = client('smoke-solo-singer', soloSessionId);
const soloTv = client('smoke-solo-tv', soloSessionId);
const handoverHost = client('smoke-handover-host', handoverSessionId);
const handoverSinger = client('smoke-handover-singer', handoverSessionId);
const handoverTarget = client('smoke-handover-target', handoverSessionId);
const handoverTv = client('smoke-handover-tv', handoverSessionId);
// Host + singer + 48 additional participants = exactly 50 active participants.
const participants = Array.from({ length: 48 }, (_, index) => client(`smoke-party-${index + 1}`));

try {
  await openClients([host, singer, tv, overflow, soloHost, soloSinger, soloTv, handoverHost, handoverSinger, handoverTarget, handoverTv, ...participants]);

  host.send('session.create', { name: 'Smoke Host', maxParticipants: 50 });
  await host.waitFor(m => m.type === 'session.created');

  singer.send('session.join', { name: 'Smoke Singer', role: 'participant' });
  await singer.waitFor(m => m.type === 'session.joined');

  tv.send('session.join', { name: 'Smoke TV', role: 'tv' });
  await tv.waitFor(m => m.type === 'session.joined');

  for (const [index, participant] of participants.entries()) {
    participant.send('session.join', { name: `Party ${index + 1}`, role: 'participant' });
    await participant.waitFor(m => m.type === 'session.joined');
  }

  overflow.send('session.join', { name: 'Overflow', role: 'participant' });
  await overflow.waitFor(m => m.type === 'session.error' && String(m.payload?.message ?? '').includes('capacidade'));

  const first = participants[0];
  for (let song = 1; song <= 3; song += 1) {
    first.send('queue.add', {
      title: `Party Song ${song}`,
      artist: 'KaraokeAI',
      sourceId: `party-source-${song}`
    });
    await first.waitFor(m => m.type === 'session.event' && m.payload?.type === 'queue.added' && m.payload?.payload?.entry?.title === `Party Song ${song}`);
  }

  first.send('queue.add', {
    title: 'Party Song 4 - should fail',
    artist: 'KaraokeAI',
    sourceId: 'party-source-4'
  });
  await first.waitFor(m => m.type === 'session.error' && String(m.payload?.message ?? '').includes('limite'));

  const queueAdded = first.messages.find(m => m.type === 'session.event' && m.payload?.type === 'queue.added');
  const queueEntryId = queueAdded.payload.payload.entry.id;
  first.send('queue.status.set', { queueEntryId, status: 'ready' });
  await first.waitFor(m => m.type === 'session.event' && m.payload?.type === 'queue.updated');

  host.send('queue.next');
  await first.waitFor(m => m.type === 'session.event' && m.payload?.type === 'performance.started');
  singer.send('playback.control', { action: 'pause', queueEntryId });
  await singer.waitFor(m => m.type === 'session.error' && String(m.payload?.message ?? '').includes('Somente o Host'));
  host.send('playback.control', { action: 'pause', queueEntryId, positionSeconds: 10 });
  await first.waitFor(m => m.type === 'session.event' && m.payload?.type === 'performance.paused');
  host.send('playback.control', { action: 'resume', queueEntryId });
  await first.waitFor(m => m.type === 'session.event' && m.payload?.type === 'performance.resumed');
  await tv.waitFor(m => m.type === 'session.event' && m.payload?.type === 'performance.started');

  tv.send('playback.finished', { queueEntryId });
  await first.waitFor(m => m.type === 'session.event' && m.payload?.type === 'performance.finished');

  first.send('performance.complete', {
    queueEntryId,
    performanceId: 'smoke-performance',
    score: { overall: 90, pitch: 90, precision: 90, rhythm: 90, stability: 90, matchedSamples: 100 }
  });
  await first.waitFor(m => m.type === 'session.event' && m.payload?.type === 'performance.scored');

  soloHost.send('session.create', { name: 'Solo Host', maxParticipants: 1 });
  await soloHost.waitFor(m => m.type === 'session.created');
  soloSinger.send('session.join', { name: 'Solo Singer', role: 'participant' });
  await soloSinger.waitFor(m => m.type === 'session.error' && String(m.payload?.message ?? '').includes('capacidade'));
  soloTv.send('session.join', { name: 'Solo TV', role: 'tv' });
  await soloTv.waitFor(m => m.type === 'session.joined');

  handoverHost.send('session.create', { name: 'Handover Host', maxParticipants: 3 });
  await handoverHost.waitFor(m => m.type === 'session.created');
  handoverSinger.send('session.join', { name: 'Handover Singer', role: 'participant' });
  await handoverSinger.waitFor(m => m.type === 'session.joined');
  handoverTarget.send('session.join', { name: 'Handover Target', role: 'participant' });
  await handoverTarget.waitFor(m => m.type === 'session.joined');
  handoverTv.send('session.join', { name: 'Handover TV', role: 'tv' });
  await handoverTv.waitFor(m => m.type === 'session.joined');

  handoverSinger.send('queue.add', { title: 'Handover Song', artist: 'KaraokeAI', sourceId: 'handover-source', durationSeconds: 120 });
  const handoverAdded = await handoverSinger.waitFor(m => m.type === 'session.event' && m.payload?.type === 'queue.added');
  const handoverQueueEntryId = handoverAdded.payload.payload.entry.id;
  handoverSinger.send('queue.status.set', { queueEntryId: handoverQueueEntryId, status: 'ready', durationSeconds: 120 });
  await handoverSinger.waitFor(m => m.type === 'session.event' && m.payload?.type === 'queue.updated');
  handoverHost.send('queue.next');
  await handoverSinger.waitFor(m => m.type === 'session.event' && m.payload?.type === 'performance.started');

  // Transferência voluntária durante a música fica pendente; a apresentação
  // não é interrompida e o novo Host só entra após o término.
  handoverHost.send('host.transfer', { targetParticipantId: 'smoke-handover-target' });
  await handoverHost.waitFor(m => m.type === 'session.event' && m.payload?.type === 'host.transfer.pending');
  handoverTv.send('playback.finished', { queueEntryId: handoverQueueEntryId });
  await handoverTarget.waitFor(m => m.type === 'session.event' && m.payload?.type === 'host.changed' && m.payload?.payload?.appliedAfterPerformance === true);

  // Queda do Host no meio de uma nova música também não permite takeover
  // imediato; a apresentação continua e o Host original pode reconectar.
  handoverSinger.send('queue.add', { title: 'Handover Disconnect Song', artist: 'KaraokeAI', sourceId: 'handover-disconnect-source', durationSeconds: 120 });
  const disconnectAdded = await handoverSinger.waitFor(m => m.type === 'session.event' && m.payload?.type === 'queue.added' && m.payload?.payload?.entry?.title === 'Handover Disconnect Song');
  const disconnectQueueEntryId = disconnectAdded.payload.payload.entry.id;
  handoverSinger.send('queue.status.set', { queueEntryId: disconnectQueueEntryId, status: 'ready', durationSeconds: 120 });
  await handoverSinger.waitFor(m => m.type === 'session.event' && m.payload?.type === 'queue.updated' && m.payload?.payload?.queueEntryId === disconnectQueueEntryId);
  handoverTarget.send('queue.next');
  await handoverSinger.waitFor(m => m.type === 'session.event' && m.payload?.type === 'performance.started' && m.payload?.payload?.queueEntryId === disconnectQueueEntryId);

  handoverTarget.ws.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  handoverSinger.send('host.claim');
  await handoverSinger.waitFor(m => m.type === 'session.error' && String(m.payload?.message ?? '').includes('música atual continua'));

  const reconnectHost = client('smoke-handover-reconnect-host', handoverSessionId);
  await reconnectHost.waitOpen;
  reconnectHost.send('session.reconnect');
  await reconnectHost.waitFor(m => m.type === 'session.reconnected');
  reconnectHost.ws.close();

  const lastParticipant = participants[47];
  lastParticipant.ws.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  const reconnect = client(lastParticipant.senderId);
  await reconnect.waitOpen;
  reconnect.send('session.reconnect');
  await reconnect.waitFor(m => m.type === 'session.reconnected');

  console.log('SIGNALING_PARTY_SMOKE_OK participants=50 queueLimit=3 capacity=1..50 role-controls=true reconnect=true');
  try { reconnect.ws.close(); } catch {}
} finally {
  for (const c of [host, singer, tv, overflow, soloHost, soloSinger, soloTv, handoverHost, handoverSinger, handoverTarget, handoverTv, ...participants]) {
    try { c.ws.close(); } catch {}
  }
}
