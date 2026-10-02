import { WebSocket } from 'ws';

const port = Number(process.env.PORT ?? 8787);
const url = `ws://127.0.0.1:${port}`;
const sessionId = `smoke-${Date.now()}`;

function client(senderId) {
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
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  return {
    ws,
    senderId,
    messages,
    waitOpen,
    waitFor(predicate, timeout = 5000) {
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
        sessionId,
        senderId,
        timestamp: Date.now(),
        payload
      }));
    }
  };
}

const host = client('smoke-host');
const singer = client('smoke-singer');
const tv = client('smoke-tv');
// Host + singer + 48 additional participants = 50 active participants.
const participants = Array.from({ length: 48 }, (_, index) => client(`smoke-party-${index + 1}`));

try {
  await Promise.all([host.waitOpen, singer.waitOpen, tv.waitOpen, ...participants.map(c => c.waitOpen)]);

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
  await tv.waitFor(m => m.type === 'session.event' && m.payload?.type === 'performance.started');

  tv.send('playback.finished', { queueEntryId });
  await first.waitFor(m => m.type === 'session.event' && m.payload?.type === 'performance.finished');

  first.send('performance.complete', {
    queueEntryId,
    performanceId: 'smoke-performance',
    score: { overall: 90, pitch: 90, precision: 90, rhythm: 90, stability: 90, matchedSamples: 100 }
  });
  await first.waitFor(m => m.type === 'session.event' && m.payload?.type === 'performance.scored');

  const lastParticipant = participants[47];
  lastParticipant.ws.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  const reconnect = client(lastParticipant.senderId);
  await reconnect.waitOpen;
  reconnect.send('session.reconnect');
  await reconnect.waitFor(m => m.type === 'session.reconnected');

  console.log('SIGNALING_PARTY_SMOKE_OK participants=50 queueLimit=3 reconnect=true');
} finally {
  for (const c of [host, singer, tv, ...participants]) {
    try { c.ws.close(); } catch {}
  }
}
