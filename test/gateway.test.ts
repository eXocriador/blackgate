import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGateway, isCounterfeit, parseRetryAfter, type CallResult } from '../src/upstream/gateway.js';

function fakeFetch(reply: { status: number; body?: unknown; headers?: Record<string, string> }) {
  return async () =>
    new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json', ...(reply.headers ?? {}) },
    });
}

const req = {
  model: 'm', messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 10, temperature: 0, timeoutMs: 1000,
};

const answer = {
  model: 'm',
  choices: [{ message: { role: 'assistant', content: 'OK42' } }],
  usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
};

/** Дослівне тіло, яким шлюз відповів на `gemini-3.5-flash-low` 2026-09-13. */
const tombstone = {
  id: '',
  object: 'chat.completion',
  created: 0,
  model: 'model',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      content: 'Gemini 3.5 Flash is no longer available. Please switch to Gemini 3.7 Flash in the latest version of Antigravity.',
    },
  }],
  usage: null,
};

describe('детектор підробленого 200', () => {
  it('упізнає справжній надгробок зі шлюзу', () => {
    expect(isCounterfeit(tombstone)).toBe(true);
  });

  it('не чіпає справжню відповідь', () => {
    expect(isCounterfeit(answer)).toBe(false);
  });

  it('не вважає підробкою відповідь без usage, але з чесним ехом моделі', () => {
    // Обидві ознаки разом, не одна: апстрім, що колись перестане слати usage,
    // не має через це стати «виведеним з експлуатації».
    expect(isCounterfeit({ ...answer, usage: null })).toBe(false);
  });

  it('HTTP 200 із надгробком класифікується як retired, а не ok', async () => {
    const gw = createGateway({ baseUrl: 'http://x', apiKey: 'k', fetchImpl: fakeFetch({ status: 200, body: tombstone }) });
    const res = await gw.call(req);
    expect(res.outcome).toBe('retired');
    expect(res.httpStatus).toBe(200);
    // Найважливіше: текст надгробка НЕ віддається як відповідь моделі.
    expect(res.content).toBeNull();
  });
});

describe('класифікація', () => {
  it('200 зі справжньою відповіддю несе токени', async () => {
    const gw = createGateway({ baseUrl: 'http://x', apiKey: 'k', fetchImpl: fakeFetch({ status: 200, body: answer }) });
    const res = await gw.call(req);
    expect(res.outcome).toBe('ok');
    expect(res.content).toBe('OK42');
    expect(res.usage).toEqual({ promptTokens: 8, completionTokens: 3, totalTokens: 11 });
  });

  it('429 → exhausted', async () => {
    const gw = createGateway({ baseUrl: 'http://x', apiKey: 'k', fetchImpl: fakeFetch({ status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } }) });
    expect((await gw.call(req)).outcome).toBe('exhausted');
  });

  it('400 → rejected', async () => {
    const gw = createGateway({ baseUrl: 'http://x', apiKey: 'k', fetchImpl: fakeFetch({ status: 400, body: { error: 'INVALID_ARGUMENT' } }) });
    expect((await gw.call(req)).outcome).toBe('rejected');
  });

  it('503 → error (варте ретраю)', async () => {
    const gw = createGateway({ baseUrl: 'http://x', apiKey: 'k', fetchImpl: fakeFetch({ status: 503 }) });
    expect((await gw.call(req)).outcome).toBe('error');
  });

  it('401 → unauthorized', async () => {
    const gw = createGateway({ baseUrl: 'http://x', apiKey: 'k', fetchImpl: fakeFetch({ status: 401 }) });
    expect((await gw.call(req)).outcome).toBe('unauthorized');
  });

  it('429 з Retry-After читається', async () => {
    const gw = createGateway({
      baseUrl: 'http://x', apiKey: 'k',
      fetchImpl: fakeFetch({ status: 429, headers: { 'Retry-After': '30' } }),
    });
    expect((await gw.call(req)).retryAfterMs).toBe(30_000);
  });

  it('429 БЕЗ Retry-After — сьогоднішній стан шлюзу — дає null, а не вигадане число', async () => {
    const gw = createGateway({ baseUrl: 'http://x', apiKey: 'k', fetchImpl: fakeFetch({ status: 429 }) });
    expect((await gw.call(req)).retryAfterMs).toBeNull();
  });
});

/**
 * Таймаут і недосяжний шлюз — справжнім fetch проти справжніх сокетів, бо вся
 * різниця між ними живе в тому, ЯК undici падає, а фальшивка це вигадала б.
 */
describe('таймаут моделі ≠ недосяжний шлюз', () => {
  async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
    const server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  it('шлюз прийняв з\'єднання й мовчить → timeout, шлюз досяжний', async () => {
    // Сервер не відповідає ніколи — так виглядає модель, що думає довше за
    // свій timeout_ms (проба gemini-premium, 2026-09-23 14:35Z).
    const { server, url } = await listen(() => {});
    try {
      const gw = createGateway({ baseUrl: url, apiKey: 'k' });
      const res = await gw.call({ ...req, timeoutMs: 100 });
      expect(res.outcome).toBe('timeout');
      expect(res.httpStatus).toBeNull();
      expect(res.unreachable).toBe(false);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('заголовки прийшли, тіло ні → теж timeout, а не «тіло не JSON»', async () => {
    const { server, url } = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"choices":');
    });
    try {
      const gw = createGateway({ baseUrl: url, apiKey: 'k' });
      const res = await gw.call({ ...req, timeoutMs: 150 });
      expect(res.outcome).toBe('timeout');
      expect(res.unreachable).toBe(false);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('відмова з\'єднання → error, шлюз недосяжний, причина undici в error', async () => {
    const { server, url } = await listen(() => {});
    server.close(); // порт звільнено — з'єднання відмовлять
    const gw = createGateway({ baseUrl: url, apiKey: 'k' });
    const res = await gw.call(req);
    expect(res.outcome).toBe('error');
    expect(res.httpStatus).toBeNull();
    expect(res.unreachable).toBe(true);
    expect(res.error).toContain('ECONNREFUSED');
  });

  it('обірване з\'єднання → шлюз недосяжний', async () => {
    const { server, url } = await listen((r) => r.socket.destroy());
    try {
      const gw = createGateway({ baseUrl: url, apiKey: 'k' });
      const res = await gw.call(req);
      expect(res.outcome).toBe('error');
      expect(res.unreachable).toBe(true);
    } finally {
      server.close();
    }
  });

  it('відповідь з кодом — досяжний, хоч би який код', async () => {
    const gw = createGateway({ baseUrl: 'http://x', apiKey: 'k', fetchImpl: fakeFetch({ status: 503 }) });
    expect((await gw.call(req)).unreachable).toBe(false);
  });

  it('onResult бачить кожну відповідь разом із запитом', async () => {
    const seen: Array<[string, CallResult['outcome']]> = [];
    const gw = createGateway({
      baseUrl: 'http://x', apiKey: 'k', fetchImpl: fakeFetch({ status: 401, body: { error: 'Invalid API key' } }),
      onResult: (r, res) => seen.push([r.model, res.outcome]),
    });
    await gw.call(req);
    expect(seen).toEqual([['m', 'unauthorized']]);
  });
});

describe('parseRetryAfter', () => {
  it('секунди', () => expect(parseRetryAfter('12')).toBe(12_000));
  it('немає заголовка', () => expect(parseRetryAfter(null)).toBeNull());
  it('сміття', () => expect(parseRetryAfter('скоро')).toBeNull());
  it('HTTP-дата в майбутньому', () => {
    const when = new Date(Date.now() + 60_000).toUTCString();
    expect(parseRetryAfter(when)!).toBeGreaterThan(50_000);
  });
});
