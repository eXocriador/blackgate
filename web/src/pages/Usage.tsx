import { useMemo } from 'react';
import { api, type Facets, type Metrics } from '../api';
import { Chart, type Series } from '../components/Chart';
import { Empty, ErrorBox, Loading, Section, Select, Stat, Table, useLoad } from '../components/ui';
import { compact, ms, n, OUTCOME, when } from '../format';
import { navigate, pathOf } from '../router';
import { densify } from '../series';

const RANGES = [
  { value: '24h', label: '24 години' },
  { value: '7d', label: '7 днів' },
  { value: '30d', label: '30 днів' },
  { value: '90d', label: '90 днів' },
];

const HOURS: Record<string, number> = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 };

export function Usage({ params }: { params: URLSearchParams }) {
  const range = params.get('range') ?? '24h';
  const product = params.get('product') ?? '';
  const tier = params.get('tier') ?? '';
  const stub = params.get('stub') === '1';

  const facets = useLoad(() => api<Facets>('/facets'), []);
  const q = new URLSearchParams({ range, ...(product ? { product } : {}), ...(tier ? { tier } : {}), ...(stub ? { stub: '1' } : {}) });
  const { data, error } = useLoad(() => api<Metrics>(`/metrics?${q}`), [q.toString()], 60_000);

  const set = (k: string, v: string) =>
    navigate(pathOf('usage', null, { range, product, tier, stub: stub ? '1' : '', [k]: v }), true);

  const charts = useMemo(() => {
    if (!data) return null;
    const hours = HOURS[data.range] ?? 24;
    const c = densify(data.calls, data.unit, hours);
    const r = densify(data.requests, data.unit, hours);
    const count = (get: (i: number) => number | undefined) => c.x.map((_, i) => get(i) ?? 0);
    const since = data.journalSince ? new Date(data.journalSince).getTime() / 1000 : Infinity;
    // До появи журналу відмов не рахували — там розрив, а не нуль.
    const fromJournal = (get: (i: number) => number | undefined) =>
      r.x.map((t, i) => (t + (data.unit === 'hour' ? 3600 : 86400) <= since ? null : (get(i) ?? 0)));
    return {
      x: c.x,
      answers: [
        { label: 'відповіді', values: count((i) => c.at(i)?.answers), role: 'accent', bars: true },
        { label: 'невдалі спроби', values: count((i) => c.at(i)?.failedAttempts), role: 'critical' },
        { label: 'пропущені сходинки', values: count((i) => c.at(i)?.skipped), role: 'ink-tertiary', dash: true },
      ] satisfies Series[],
      tokens: [
        { label: 'вхід', values: count((i) => c.at(i)?.promptTokens), role: 'accent' },
        { label: 'вихід', values: count((i) => c.at(i)?.completionTokens), role: 'ok' },
      ] satisfies Series[],
      latency: [
        { label: 'p50', values: c.x.map((_, i) => c.at(i)?.p50 ?? null), role: 'accent' },
        { label: 'p95', values: c.x.map((_, i) => c.at(i)?.p95 ?? null), role: 'caution' },
      ] satisfies Series[],
      rungs: [
        { label: 'сходинка 0', values: count((i) => c.at(i)?.rung0), role: 'ok' },
        { label: 'сходинка 1', values: count((i) => c.at(i)?.rung1), role: 'caution' },
        { label: 'сходинка 2+', values: count((i) => c.at(i)?.rung2), role: 'critical' },
      ] satisfies Series[],
      refusals: [
        { label: 'відповіді', values: fromJournal((i) => r.at(i)?.ok), role: 'ok' },
        { label: '400/401', values: fromJournal((i) => r.at(i)?.rejected), role: 'ink-tertiary' },
        { label: '429 стеля', values: fromJournal((i) => r.at(i)?.capped), role: 'caution' },
        { label: '5xx', values: fromJournal((i) => r.at(i)?.failed), role: 'critical' },
      ] satisfies Series[],
      rx: r.x,
      totals: {
        answers: data.calls.reduce((s, b) => s + b.answers, 0),
        tokens: data.calls.reduce((s, b) => s + b.totalTokens, 0),
        failed: data.calls.reduce((s, b) => s + b.failedAttempts, 0),
        fallback: data.calls.reduce((s, b) => s + b.rung1 + b.rung2, 0),
      },
    };
  }, [data]);

  const productOptions = [{ value: '', label: 'усі' }, ...(facets.data?.products ?? []).map((p) => ({ value: p, label: p }))];
  const tierOptions = [{ value: '', label: 'усі' }, ...(facets.data?.tiers ?? []).map((t) => ({ value: t, label: t }))];

  return (
    <div className="grid gap-8">
      <div className="flex flex-wrap items-end gap-3">
        <Select label="Період" value={range} onChange={(v) => set('range', v)} options={RANGES} />
        <Select label="Продукт" value={product} onChange={(v) => set('product', v)} options={productOptions} />
        <Select label="Тир" value={tier} onChange={(v) => set('tier', v)} options={tierOptions} />
        <label className="flex h-9 items-center gap-2 text-sm text-ink-secondary">
          <input type="checkbox" checked={stub} onChange={(e) => set('stub', e.target.checked ? '1' : '')} />
          рахувати заглушку
        </label>
      </div>
      <ErrorBox error={error} />
      {!data || !charts ? (
        !error && <Loading />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Відповідей моделей" value={compact(charts.totals.answers)} />
            <Stat label="Токенів" value={compact(charts.totals.tokens)} />
            <Stat label="Невдалих спроб" value={compact(charts.totals.failed)} tone={charts.totals.failed ? 'caution' : undefined} />
            <Stat
              label="Відповіла не основна"
              value={charts.totals.answers ? `${Math.round((charts.totals.fallback / charts.totals.answers) * 100)} %` : '—'}
              hint="частка відповідей зі сходинки ≥ 1"
            />
          </div>

          <Section title="Відповіді й спроби" aside="з ai_call — кожна спроба драбини">
            <Chart x={charts.x} series={charts.answers} unit={data.unit} format={compact} />
          </Section>
          <div className="grid gap-8 lg:grid-cols-2">
            <Section title="Токени">
              <Chart x={charts.x} series={charts.tokens} unit={data.unit} format={compact} height={180} />
            </Section>
            <Section title="Латентність відповіді моделі">
              <Chart x={charts.x} series={charts.latency} unit={data.unit} format={ms} height={180} />
            </Section>
            <Section title="Хто відповів: сходинка драбини">
              <Chart x={charts.x} series={charts.rungs} unit={data.unit} format={compact} height={180} />
            </Section>
            <Section
              title="Запити й відмови"
              aside={data.journalSince ? `журнал веде з ${when(data.journalSince, true)}` : 'журнал порожній'}
            >
              <Chart x={charts.rx} series={charts.refusals} unit={data.unit} format={compact} height={180} />
            </Section>
          </div>

          <Section title="Моделі">
            {data.byModel.length === 0 ? <Empty>За період нічого.</Empty> : (
              <Table>
                <thead><tr><th>модель</th><th>пул</th><th>відповіді</th><th>невдалі</th><th>пропущені</th><th>токени</th><th>p50</th></tr></thead>
                <tbody>
                  {data.byModel.map((m) => (
                    <tr key={`${m.pool}/${m.model}`}>
                      <td className="font-mono text-xs">{m.model}</td>
                      <td className="text-ink-secondary">{m.pool}</td>
                      <td className="tabular-nums">{n(m.answers)}</td>
                      <td className={m.failed ? 'text-critical tabular-nums' : 'tabular-nums'}>{n(m.failed)}</td>
                      <td className="text-ink-tertiary tabular-nums">{n(m.skipped)}</td>
                      <td className="tabular-nums">{compact(m.tokens)}</td>
                      <td className="tabular-nums">{ms(m.p50)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Section>

          <div className="grid gap-8 lg:grid-cols-2">
            <Section title="Продукти">
              <Table>
                <thead><tr><th>продукт</th><th>відповіді</th><th>вхід</th><th>вихід</th><th>разом</th></tr></thead>
                <tbody>
                  {data.byProduct.map((p) => (
                    <tr key={p.product}>
                      <td className="font-medium">{p.product}</td>
                      <td className="tabular-nums">{n(p.answers)}</td>
                      <td className="tabular-nums">{compact(p.promptTokens)}</td>
                      <td className="tabular-nums">{compact(p.completionTokens)}</td>
                      <td className="tabular-nums">{compact(p.tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Section>
            <Section title="Результати спроб">
              <Table>
                <thead><tr><th>результат</th><th>спроб</th></tr></thead>
                <tbody>
                  {data.byOutcome.map((o) => (
                    <tr key={o.outcome}><td>{OUTCOME[o.outcome] ?? o.outcome}</td><td className="tabular-nums">{n(o.n)}</td></tr>
                  ))}
                </tbody>
              </Table>
            </Section>
          </div>
        </>
      )}
    </div>
  );
}
