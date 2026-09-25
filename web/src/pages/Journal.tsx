import { Button, Card, Input, Tag } from '@exo/kit-ui';
import { useEffect, useState } from 'react';
import { api, type ChatMessage, type Facets, type JournalDetail, type JournalRow } from '../api';
import { Empty, ErrorBox, Loading, Mono, Section, Select, Table, useLoad } from '../components/ui';
import { compact, ms, n, OUTCOME, statusLabel, statusTone, when } from '../format';
import { go, navigate, pathOf } from '../router';

const STATUS = [
  { value: '', label: 'усі' },
  { value: 'ok', label: 'відповіді (200)' },
  { value: 'error', label: 'відмови й збої (≥400)' },
  { value: '400', label: '400 запит' },
  { value: '401', label: '401 ключ' },
  { value: '429', label: '429 стеля' },
  { value: '503', label: '503 драбина' },
  { value: '500', label: '500 внутрішня' },
];
const SOURCE = [
  { value: '', label: 'усі' },
  { value: 'api', label: 'продукти' },
  { value: 'console', label: 'пісочниця' },
];

export function Journal({ params, id }: { params: URLSearchParams; id: number | null }) {
  if (id !== null) return <Detail id={id} back={params.get('back')} />;
  return <List params={params} />;
}

function List({ params }: { params: URLSearchParams }) {
  const filter = {
    product: params.get('product') ?? '',
    status: params.get('status') ?? '',
    source: params.get('source') ?? '',
    tier: params.get('tier') ?? '',
    q: params.get('q') ?? '',
  };
  const [q, setQ] = useState(filter.q);
  useEffect(() => setQ(filter.q), [filter.q]);
  const [pages, setPages] = useState<JournalRow[][]>([]);
  const [more, setMore] = useState<{ loading: boolean; error: unknown; done: boolean }>({ loading: false, error: null, done: false });

  const facets = useLoad(() => api<Facets>('/facets'), []);
  const query = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as [string, string][]);
  const first = useLoad(() => api<{ items: JournalRow[] }>(`/requests?${query}&limit=50`), [query.toString()], 20_000);
  useEffect(() => {
    setPages([]);
    setMore({ loading: false, error: null, done: false });
  }, [query.toString()]);

  const set = (patch: Partial<typeof filter>) => navigate(pathOf('journal', null, { ...filter, ...patch }), true);
  const rows = [...(first.data?.items ?? []), ...pages.flat()];

  async function loadMore() {
    const last = rows.at(-1);
    if (!last) return;
    setMore({ loading: true, error: null, done: false });
    try {
      const next = await api<{ items: JournalRow[] }>(`/requests?${query}&limit=50&before=${last.id}`);
      setPages((p) => [...p, next.items]);
      setMore({ loading: false, error: null, done: next.items.length < 50 });
    } catch (error) {
      setMore({ loading: false, error, done: false });
    }
  }

  const here = `${window.location.pathname}${window.location.search}`;

  return (
    <div className="grid gap-5">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => { e.preventDefault(); set({ q: q.trim() }); }}
      >
        <Select label="Продукт" value={filter.product} onChange={(v) => set({ product: v })}
          options={[{ value: '', label: 'усі' }, ...(facets.data?.products ?? []).map((p) => ({ value: p, label: p }))]} />
        <Select label="Статус" value={filter.status} onChange={(v) => set({ status: v })} options={STATUS} />
        <Select label="Звідки" value={filter.source} onChange={(v) => set({ source: v })} options={SOURCE} />
        <Select label="Тир" value={filter.tier} onChange={(v) => set({ tier: v })}
          options={[{ value: '', label: 'усі' }, ...(facets.data?.tiers ?? []).map((t) => ({ value: t, label: t }))]} />
        <label className="grid min-w-56 flex-1 gap-1 text-xs text-ink-tertiary">
          Пошук у вмісті, гаманці, request_id, трейсі
          <Input size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="напр. exopost:stage:classify" />
        </label>
        <Button type="submit" size="sm" variant="primary">Шукати</Button>
      </form>

      <ErrorBox error={first.error} />
      {!first.data ? (
        !first.error && <Loading />
      ) : rows.length === 0 ? (
        <Empty>Нічого не знайдено. Журнал веде кожен /v1/complete з 25.09.2026.</Empty>
      ) : (
        <Table>
          <thead>
            <tr><th>#</th><th>час</th><th>продукт · гаманець</th><th>тир</th><th>статус</th><th>хто відповів</th><th>токени</th><th>час відповіді</th><th>вхід → вихід</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const href = pathOf('journal', r.id, { back: here });
              return (
                <tr key={r.id} className="cursor-pointer align-top hover:bg-lift" onClick={() => navigate(href)}>
                  <td><a href={href} onClick={(e) => { e.stopPropagation(); go(e, href); }} className="text-accent tabular-nums">{r.id}</a></td>
                  <td className="whitespace-nowrap text-ink-secondary">{when(r.at)}</td>
                  <td>
                    <div className="font-medium">{r.product ?? <span className="text-ink-tertiary">без ключа</span>}{r.source === 'console' && <Tag tone="accent" className="ml-1.5">пісочниця</Tag>}</div>
                    <div className="max-w-56 truncate text-xs text-ink-tertiary">{r.subject ?? ''}</div>
                  </td>
                  <td>{r.tier ?? '—'}</td>
                  <td className="whitespace-nowrap">
                    <Tag tone={statusTone(r.status)}>{r.status} {statusLabel(r.status, r.error)}</Tag>
                    {r.stub && <Tag tone="caution" className="ml-1">заглушка</Tag>}
                  </td>
                  <td className="text-xs">
                    {r.model ? <><span className="font-mono">{r.model}</span><div className="text-ink-tertiary">сходинка {r.rung} · спроб {r.attempts}</div></> : <span className="text-ink-tertiary">{r.attempts ? `спроб ${r.attempts}` : '—'}</span>}
                  </td>
                  <td className="tabular-nums">{r.total_tokens === null ? '—' : compact(r.total_tokens)}</td>
                  <td className="tabular-nums whitespace-nowrap">{ms(r.latency_ms)}</td>
                  <td className="max-w-80 text-xs">
                    {!r.content_stored ? <span className="text-ink-tertiary">вміст не зберігався</span>
                      : r.content_purged_at ? <span className="text-ink-tertiary">вміст стерто за строком</span>
                      : (
                        <>
                          <div className="line-clamp-2 break-words">{r.input_preview ?? ''}</div>
                          {(r.output_preview || r.error_detail) && (
                            <div className="line-clamp-2 break-words text-ink-tertiary">→ {r.output_preview ?? r.error_detail}</div>
                          )}
                        </>
                      )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <ErrorBox error={more.error} />
      {rows.length >= 50 && !more.done && (
        <Button onClick={() => void loadMore()} disabled={more.loading} className="justify-self-start">
          {more.loading ? 'Завантажую…' : 'Ще 50'}
        </Button>
      )}
    </div>
  );
}

function Detail({ id, back }: { id: number; back: string | null }) {
  const { data, error } = useLoad(() => api<JournalDetail>(`/requests/${id}`), [id]);
  const backHref = back && back.startsWith('/journal') ? back : pathOf('journal');
  const messages = Array.isArray(data?.input) ? (data!.input as ChatMessage[]) : null;

  return (
    <div className="grid gap-6">
      <a href={backHref} onClick={(e) => go(e, backHref)} className="text-sm text-accent underline">← до журналу</a>
      <ErrorBox error={error} />
      {!data ? (!error && <Loading />) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">Запит #{data.id}</h2>
            <Tag tone={statusTone(data.status)} size="md">{data.status} {statusLabel(data.status, data.error)}</Tag>
            {data.stub && <Tag tone="caution" size="md">заглушка</Tag>}
            {data.source === 'console' && <Tag tone="accent" size="md">пісочниця</Tag>}
            <span className="grow" />
            {messages && data.product && data.tier && (
              <Button
                size="sm"
                onClick={() => {
                  sessionStorageSet('blackgate:sandbox-prefill', JSON.stringify({
                    product: data.product, tier: data.tier, messages,
                    max_tokens: data.params?.max_tokens, temperature: data.params?.temperature,
                  }));
                  navigate(pathOf('sandbox', null, { from: String(data.id) }));
                }}
              >
                Повторити в пісочниці
              </Button>
            )}
          </div>

          <Card variant="flat" padding="md">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[max-content_1fr_max-content_1fr]">
              <Row k="час" v={when(data.at)} />
              <Row k="продукт" v={data.product ?? 'без ключа'} />
              <Row k="гаманець" v={data.subject} mono />
              <Row k="request_id" v={data.request_id} mono />
              <Row k="тир" v={data.tier} />
              <Row k="параметри" v={data.params ? `max_tokens ${data.params.max_tokens} · temperature ${data.params.temperature}` : null} />
              <Row k="відповіла" v={data.model ? `${data.model} (${data.pool}, сходинка ${data.rung})` : null} mono />
              <Row k="час відповіді" v={ms(data.latency_ms)} />
              <Row k="токени" v={data.total_tokens === null ? null : `${n(data.prompt_tokens)} вхід · ${n(data.completion_tokens)} вихід · ${n(data.total_tokens)} разом`} />
              <Row k="помилка" v={data.error ? `${data.error}${data.error_detail ? ` — ${data.error_detail}` : ''}` : null} />
              <Row k="трейс" v={data.trace_id} mono />
              <Row k="батьківський спан" v={data.parent_span_id} mono />
              <Row k="сесія" v={data.session_id} mono />
            </dl>
            {data.metadata && <Mono className="mt-3">{JSON.stringify(data.metadata, null, 2)}</Mono>}
          </Card>

          <Section title="Вхід">
            {!data.content_stored ? <Empty>Вміст не зберігався (налаштування «зберігати вміст» було вимкнене).</Empty>
              : data.content_purged_at ? <Empty>Вміст стерто за строком {when(data.content_purged_at)}.</Empty>
              : messages ? (
                <div className="grid gap-2">
                  {messages.map((m, i) => (
                    <div key={i} className="grid gap-1">
                      <span className="text-xs font-medium text-ink-tertiary">{m.role}</span>
                      <Mono>{m.content}</Mono>
                    </div>
                  ))}
                </div>
              ) : <Mono>{typeof data.input === 'string' ? data.input : JSON.stringify(data.input, null, 2)}</Mono>}
          </Section>

          {data.content_stored && !data.content_purged_at && (
            <Section title="Вихід">
              {data.output === null ? <Empty>Відповіді немає.</Empty> : <Mono>{data.output}</Mono>}
            </Section>
          )}

          <Section title="Спроби драбини" aside="рядки ai_call з цим запитом">
            {data.attemptRows.length === 0 ? <Empty>Спроб не було — відмова до драбини.</Empty> : (
              <Table>
                <thead><tr><th>сходинка</th><th>модель</th><th>пул</th><th>результат</th><th>HTTP</th><th>разів</th><th>час</th><th>токени</th><th>деталі</th></tr></thead>
                <tbody>
                  {data.attemptRows.map((a) => (
                    <tr key={a.id} className="align-top">
                      <td className="tabular-nums">{a.rung}</td>
                      <td className="font-mono text-xs">{a.model}</td>
                      <td className="text-ink-secondary">{a.pool}</td>
                      <td><Tag tone={a.outcome === 'ok' ? 'ok' : a.outcome === 'skipped' ? 'neutral' : 'critical'}>{OUTCOME[a.outcome] ?? a.outcome}</Tag></td>
                      <td className="tabular-nums">{a.http_status ?? '—'}</td>
                      <td className="tabular-nums">{a.tries}</td>
                      <td className="tabular-nums">{ms(a.latency_ms)}</td>
                      <td className="tabular-nums">{a.total_tokens === null ? '—' : n(a.total_tokens)}</td>
                      <td className="max-w-md text-xs break-words text-ink-secondary">{a.detail ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string | null | undefined; mono?: boolean }) {
  if (v === null || v === undefined || v === '') return null;
  return (
    <>
      <dt className="text-ink-tertiary">{k}</dt>
      <dd className={mono ? 'font-mono text-xs break-all' : 'break-words'}>{v}</dd>
    </>
  );
}

function sessionStorageSet(k: string, v: string) {
  try { window.sessionStorage.setItem(k, v); } catch { /* приватне вікно — без передзаповнення */ }
}
