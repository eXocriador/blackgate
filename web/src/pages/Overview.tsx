import { Card, Tag } from '@exo/kit-ui';
import { api, type Overview as Data } from '../api';
import { ErrorBox, Loading, Meter, Section, Stat, Table, useLoad, Empty } from '../components/ui';
import { compact, ms, n, POOL_STATE, poolTone, relative, UPSTREAM_STATE, when } from '../format';
import { go, pathOf } from '../router';

const CHECK: Record<string, string> = {
  catalog: 'реєстр', database: 'база', redis: 'Redis', pools: 'пули', upstream: 'вхід апстріму',
};

export function Overview() {
  const { data, error, loading } = useLoad(() => api<Data>('/overview'), [], 15_000);
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;

  const up = data.ready.upstream;
  const readyOk = data.ready.status === 200;
  const today = data.today ?? [];
  const total = today.reduce(
    (acc, r) => ({ requests: acc.requests + r.requests, ok: acc.ok + r.ok, refused: acc.refused + r.refused, failed: acc.failed + r.failed, tokens: acc.tokens + r.tokens }),
    { requests: 0, ok: 0, refused: 0, failed: 0, tokens: 0 },
  );

  return (
    <div className="grid gap-8">
      <ErrorBox error={error} title="Оновлення не вдалось" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Готовність"
          value={readyOk ? 'готовий' : 'не готовий'}
          tone={readyOk ? 'ok' : 'critical'}
          hint={loading ? 'оновлюю…' : `версія ${data.ready.version ?? '—'}`}
        />
        <Stat
          label="Вхід апстріму"
          value={UPSTREAM_STATE[up?.state ?? 'unknown'] ?? up?.state}
          tone={up?.state === 'ok' ? 'ok' : up?.state === 'unknown' ? 'caution' : 'critical'}
          hint={up?.since ? `з ${when(up.since, true)}` : undefined}
        />
        <Stat label="Запитів сьогодні" value={compact(total.requests)} hint={`відповідей ${n(total.ok)} · відмов ${n(total.refused)} · 5xx ${n(total.failed)}`} />
        <Stat label="Токенів сьогодні" value={compact(total.tokens)} hint="доба UTC, як і стелі" />
      </div>

      {up?.detail && (
        <Card variant="flat" padding="md" className="border-critical/40 text-sm">
          <strong className="text-critical">Вхід апстріму:</strong> {up.detail}
        </Card>
      )}

      <Section title="Перевірки готовності">
        <div className="flex flex-wrap gap-2">
          {Object.entries(data.ready.checks ?? {}).map(([k, v]) => (
            <Tag key={k} tone={poolTone(v)} size="md" dot>{CHECK[k] ?? k}: {v}</Tag>
          ))}
        </div>
      </Section>

      <Section title="Пули" aside="проба кожні 5 хв; 429 — метр, не поломка">
        <Table>
          <thead><tr><th>пул</th><th>стан</th><th>перевірено</th><th>охолодження</th><th>латентність</th><th>деталі</th></tr></thead>
          <tbody>
            {data.pools.map((p) => (
              <tr key={p.pool}>
                <td className="font-medium">{p.pool}</td>
                <td><Tag tone={poolTone(p.state)} dot>{POOL_STATE[p.state] ?? p.state}</Tag></td>
                <td className="text-ink-secondary">{relative(p.checkedAt)}</td>
                <td className="text-ink-secondary">{p.cooldownUntil ? relative(p.cooldownUntil) : '—'}</td>
                <td className="tabular-nums">{ms(p.latencyMs)}</td>
                <td className="max-w-md text-ink-secondary">{p.detail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Section>

      <Section title="Штрафний ящик моделей" aside="модель мертва сама по собі, поки сусіди по пулу живі">
        {data.penalties.length === 0 ? (
          <Empty>Порожньо — жодна модель не покарана.</Empty>
        ) : (
          <Table>
            <thead><tr><th>модель</th><th>чому</th><th>до</th></tr></thead>
            <tbody>
              {data.penalties.map((p) => (
                <tr key={p.model}><td className="font-mono text-xs">{p.model}</td><td>{p.why}</td><td>{relative(p.until)}</td></tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>

      <Section title="Стелі на сьогодні" aside={<a className="text-accent underline" href={pathOf('settings')} onClick={(e) => go(e, pathOf('settings'))}>змінити</a>}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.caps.map((c) => {
            const t = today.find((r) => r.product === c.product);
            return (
              <Card key={c.product} variant="raised" padding="md" className="grid gap-2">
                <div className="flex items-baseline justify-between gap-2">
                  <strong>{c.product}</strong>
                  {c.custom && <Tag tone="accent">своя стеля</Tag>}
                </div>
                <Meter used={c.used} cap={c.cap} />
                <div className="flex justify-between text-xs text-ink-secondary">
                  <span>{c.used === null ? 'Redis недоступний' : `${n(c.used)} з ${n(c.cap)}`}</span>
                  <span>гаманець ≤ {n(c.subjectCap)}</span>
                </div>
                {t && (
                  <div className="text-xs text-ink-tertiary">
                    журнал: {n(t.requests)} запитів · {n(t.refused)} відмов · {n(t.failed)} 5xx · {compact(t.tokens)} токенів{t.stubbed ? ` · заглушка ${n(t.stubbed)}` : ''}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </Section>

      <div className="grid gap-8 lg:grid-cols-2">
        <Section title="Драбини тирів">
          <div className="grid gap-2">
            {data.tiers.map((t) => (
              <Card key={t.tier} variant="flat" padding="md" className="grid gap-1.5">
                <strong className="text-sm">{t.tier}</strong>
                <ol className="grid gap-1 text-xs">
                  {t.rungs.map((r) => (
                    <li key={r.rung} className="flex flex-wrap gap-x-2">
                      <span className="w-4 text-ink-tertiary tabular-nums">{r.rung}</span>
                      <span className="font-mono">{r.model}</span>
                      <span className="text-ink-tertiary">{r.pool} · {ms(r.timeoutMs)}</span>
                    </li>
                  ))}
                </ol>
              </Card>
            ))}
          </div>
        </Section>
        <Section title="Заглушка й журнал" aside={<a className="text-accent underline" href={pathOf('stub')} onClick={(e) => go(e, pathOf('stub'))}>правити</a>}>
          <Card variant="flat" padding="md" className="grid gap-3 text-sm">
            <div>
              <span className="text-ink-tertiary">Заглушка відповідає замість моделей:</span>{' '}
              {data.stub.length === 0 ? <span>нікому</span> : (
                <span className="inline-flex flex-wrap gap-1.5 align-middle">{data.stub.map((s) => <Tag key={s} tone="caution">{s}</Tag>)}</span>
              )}
            </div>
            <div>
              <span className="text-ink-tertiary">Вміст запитів:</span>{' '}
              {data.journal.storeContent ? 'зберігається' : 'не зберігається'}, строк вмісту{' '}
              {data.journal.contentDays ? `${data.journal.contentDays} дн.` : 'без строку'}, рядка{' '}
              {data.journal.retentionDays ? `${data.journal.retentionDays} дн.` : 'без строку'}
            </div>
          </Card>
        </Section>
      </div>
    </div>
  );
}
