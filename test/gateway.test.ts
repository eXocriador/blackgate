import { describe, it, expect } from 'vitest';
import { createGateway, isCounterfeit, parseRetryAfter } from '../src/upstream/gateway.js';

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

describe('parseRetryAfter', () => {
  it('секунди', () => expect(parseRetryAfter('12')).toBe(12_000));
  it('немає заголовка', () => expect(parseRetryAfter(null)).toBeNull());
  it('сміття', () => expect(parseRetryAfter('скоро')).toBeNull());
  it('HTTP-дата в майбутньому', () => {
    const when = new Date(Date.now() + 60_000).toUTCString();
    expect(parseRetryAfter(when)!).toBeGreaterThan(50_000);
  });
});
