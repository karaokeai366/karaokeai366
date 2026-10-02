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

try {
  await Promise.all([host.waitOpen, singer.waitOpen, tv.waitOpen]);

  host.send('session.create', { name: 'Smoke Host', maxParticipants: 50 });
  await host.waitFor(m => m.type === 'session.created');

  singer.send('session.join', { name: 'Smoke Singer', role: 'participant' });
  await singer.waitFor(m => m.type === 'session.joined');

  tv.send('session.join', { name: 'Smoke TV', role: 'tv' });
  await tv.waitFor(m => m.type === 'session.joined');

  singer.send('queue.add', {
    title: 'Smoke Song',
    artist: 'KaraokeAI',
    sourceId: 'smoke-source'
  });
  const added = await singer.waitFor(m => m.type === 'session.event' && m.payload?.type === 'queue.added');
  const queueEntryId = added.payload.payload.entry.id;

  singer.send('queue.status.set', { queueEntryId, status: 'ready' });
  await singer.waitFor(m => m.type === 'session.event' && m.payload?.type === 'queue.updated');

  host.send('queue.next');
  await singer.waitFor(m => m.type === 'session.event' && m.payload?.type === 'performance.started');
  await tv.waitFor(m => m.type === 'session.event' && m.payload?.type === 'performance.started');

  tv.send('playback.finished', { queueEntryId });
  await singer.waitFor(m => m.type === 'session.event' && m.payload?.type === 'performance.finished');

  singer.send('performance.complete', {
    queueEntryId,
    performanceId: 'smoke-performance',
    score: { overall: 90, pitch: 90, precision: 90, rhythm: 90, stability: 90, matchedSamples: 100 }
  });
  await singer.waitFor(m => m.type === 'session.event' && m.payload?.type === 'performance.scored');

  console.log('SIGNALING_SMOKE_OK');
} finally {
  for (const c of [host, singer, tv]) {
    try { c.ws.close(); } catch {}
  }
}
