// Fields of session events that identify a visitor: their photo, renders and kept-look link.
const PRIVATE_FIELDS = ['imageDataUrl', 'qrDataUrl', 'url'];

// Server-sent events for the mirror UI. One hub per backend; each event carries its type and,
// for session events, the sessionId so a client can filter. A client watching all sessions (no
// sessionId) gets session events without PRIVATE_FIELDS unless it is privileged (the operator).
export function createEventHub({ heartbeatMs = 15_000 } = {}) {
  const clients = new Set();

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      client.raw.write(': keep-alive\n\n');
    }
  }, heartbeatMs);
  heartbeat.unref();

  return {
    // Takes over a Fastify reply and keeps it open as an event stream.
    attach(reply, { sessionId = null, initial = [], privileged = false } = {}) {
      reply.hijack();
      reply.raw.writeHead(200, {
        ...reply.getHeaders(),
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-content-type-options': 'nosniff'
      });
      const client = { raw: reply.raw, sessionId, privileged };
      clients.add(client);
      for (const event of initial) {
        write(client, event);
      }
      reply.raw.on('close', () => clients.delete(client));
    },

    publish(event) {
      const stamped = { ...event, at: Date.now() };
      for (const client of clients) {
        if (client.sessionId && stamped.sessionId && client.sessionId !== stamped.sessionId) {
          continue;
        }
        write(client, !client.sessionId && stamped.sessionId && !client.privileged ? withoutPrivate(stamped) : stamped);
      }
    },

    size: () => clients.size,

    close() {
      clearInterval(heartbeat);
      for (const client of clients) {
        client.raw.end();
      }
      clients.clear();
    }
  };
}

function withoutPrivate(event) {
  const copy = { ...event };
  for (const field of PRIVATE_FIELDS) {
    if (field in copy) {
      copy[field] = null;
    }
  }
  return copy;
}

function write(client, event) {
  client.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
