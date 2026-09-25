import { Button, Card, Input, Tag } from '@exo/kit-ui';
import { useEffect, useState } from 'react';
import { api, type ChatMessage, type Facets, type SandboxResult } from '../api';
import { ErrorBox, Mono, Section, Select, Table } from '../components/ui';
import { ms, n, OUTCOME, statusLabel, statusTone } from '../format';
import { go, pathOf } from '../router';

interface Attempt {
  rung: number; model: string; pool: string; outcome: string; httpStatus: number | null;
  latencyMs: number; tries: number; totalTokens: number | null; detail: string | null;
}

const PREFILL = 'blackgate:sandbox-prefill';

function readPrefill(): { product?: string; tier?: string; messages?: ChatMessage[]; max_tokens?: number; temperature?: number } | null {
  try {
    const raw = window.sessionStorage.getItem(PREFILL);
    if (!raw) return null;
    window.sessionStorage.removeItem(PREFILL);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Запит від імені продукту через ТЕ САМЕ ядро, що й /v1/complete: стеля,
 * заглушка, драбина, облік. Гаманець — `console:<користувач>`, тож денна стеля
 * клієнтів продукту не з'їдається, а запис видно в журналі окремо.
 */
export function Sandbox({ params }: { params: URLSearchParams }) {
  const [facets, setFacets] = useState<Facets | null>(null);
  const [product, setProduct] = useState('');
  const [tier, setTier] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'system', content: '' },
    { role: 'user', content: '' },
  ]);
  const [maxTokens, setMaxTokens] = useState('512');
  const [temperature, setTemperature] = useState('0.3');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<SandboxResult | null>(null);

  useEffect(() => {
    const pre = readPrefill();
    if (pre) {
      if (pre.product) setProduct(pre.product);
      if (pre.tier) setTier(pre.tier);
      if (pre.messages?.length) setMessages(pre.messages);
      if (pre.max_tokens) setMaxTokens(String(pre.max_tokens));
      if (pre.temperature !== undefined) setTemperature(String(pre.temperature));
    }
    api<Facets>('/facets').then((f) => {
      setFacets(f);
      setProduct((p) => p || f.keyProducts[0] || '');
      setTier((t) => t || f.catalogTiers[0] || '');
    }, setError);
  }, []);

  async function send() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api<SandboxResult>('/sandbox', {
        method: 'POST',
        body: {
          product, tier,
          messages: messages.filter((m) => m.content.trim() !== ''),
          max_tokens: Number(maxTokens),
          temperature: Number(temperature),
        },
      }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const update = (i: number, patch: Partial<ChatMessage>) =>
    setMessages((ms) => ms.map((m, k) => (k === i ? { ...m, ...patch } : m)));
  const attempts = (result?.body['attempts'] as Attempt[] | undefined) ?? [];
  const journalHref = result?.journalId ? pathOf('journal', result.journalId) : null;

  return (
    <div className="grid gap-6">
      {params.get('from') && <p className="text-sm text-ink-secondary">Передзаповнено з запиту #{params.get('from')}.</p>}
      <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <div className="flex flex-wrap items-end gap-3">
          <Select label="Від імені продукту" value={product} onChange={setProduct}
            options={(facets?.keyProducts ?? []).map((p) => ({ value: p, label: p }))} />
          <Select label="Тир" value={tier} onChange={setTier}
            options={(facets?.catalogTiers ?? []).map((t) => ({ value: t, label: t }))} />
          <label className="grid w-28 gap-1 text-xs text-ink-tertiary">
            max_tokens
            <Input size="sm" type="number" min={1} max={32000} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
          </label>
          <label className="grid w-28 gap-1 text-xs text-ink-tertiary">
            temperature
            <Input size="sm" type="number" min={0} max={2} step={0.1} value={temperature} onChange={(e) => setTemperature(e.target.value)} />
          </label>
        </div>

        <div className="grid gap-3">
          {messages.map((m, i) => (
            <div key={i} className="grid gap-1.5">
              <div className="flex items-center gap-2">
                <select
                  aria-label="Роль"
                  value={m.role}
                  onChange={(e) => update(i, { role: e.target.value as ChatMessage['role'] })}
                  className="h-8 rounded-control border border-line bg-sunken px-2 text-xs"
                >
                  <option value="system">system</option>
                  <option value="user">user</option>
                  <option value="assistant">assistant</option>
                </select>
                <Button variant="ghost" size="sm" onClick={() => setMessages((ms) => ms.filter((_, k) => k !== i))} disabled={messages.length <= 1}>
                  прибрати
                </Button>
              </div>
              <textarea
                value={m.content}
                onChange={(e) => update(i, { content: e.target.value })}
                rows={m.role === 'system' ? 3 : 5}
                className="w-full rounded-control border border-line bg-sunken p-3 font-mono text-xs text-ink focus-visible:outline-2 focus-visible:outline-focus"
                placeholder={m.role === 'system' ? 'Системний промпт (необов’язково)' : 'Текст повідомлення'}
              />
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setMessages((ms) => [...ms, { role: 'user', content: '' }])}>+ повідомлення</Button>
            <span className="grow" />
            <Button type="submit" variant="primary" disabled={busy || !product || !tier}>
              {busy ? 'Чекаю відповіді…' : 'Надіслати'}
            </Button>
          </div>
        </div>
        {facets && (
          <p className="text-xs text-ink-tertiary">
            Сценарії заглушки (лише там, де вона в режимі always): {facets.scenarios.map((s) => `[stub:${s}]`).join(' ')} — мітку дописати в текст.
          </p>
        )}
      </form>

      <ErrorBox error={error} />
      {result && (
        <Section
          title="Відповідь"
          aside={journalHref && <a className="text-accent underline" href={journalHref} onClick={(e) => go(e, journalHref)}>у журналі #{result.journalId}</a>}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Tag tone={statusTone(result.status)} size="md">{result.status} {statusLabel(result.status, String(result.body['error'] ?? ''))}</Tag>
            {result.body['stub'] === true && <Tag tone="caution" size="md">заглушка</Tag>}
            {typeof result.body['model'] === 'string' && <span className="font-mono text-xs">{String(result.body['model'])} · сходинка {String(result.body['rung'])}</span>}
            {typeof result.body['totalLatencyMs'] === 'number' && <span className="text-xs text-ink-tertiary">{ms(result.body['totalLatencyMs'] as number)}</span>}
          </div>
          {typeof result.body['content'] === 'string' ? <Mono>{String(result.body['content'])}</Mono>
            : <Mono>{JSON.stringify(result.body, null, 2)}</Mono>}
          {attempts.length > 0 && (
            <Card variant="flat" padding="none">
              <Table className="border-0">
                <thead><tr><th>сходинка</th><th>модель</th><th>результат</th><th>час</th><th>токени</th><th>деталі</th></tr></thead>
                <tbody>
                  {attempts.map((a, i) => (
                    <tr key={i}>
                      <td className="tabular-nums">{a.rung}</td>
                      <td className="font-mono text-xs">{a.model}</td>
                      <td>{OUTCOME[a.outcome] ?? a.outcome}{a.tries > 1 ? ` ×${a.tries}` : ''}</td>
                      <td className="tabular-nums">{ms(a.latencyMs)}</td>
                      <td className="tabular-nums">{n(a.totalTokens)}</td>
                      <td className="text-xs text-ink-secondary">{a.detail ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
        </Section>
      )}
    </div>
  );
}
