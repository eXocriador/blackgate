import { Card, cn } from '@exo/kit-ui';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api';

/**
 * Завантаження з відміною застарілого: швидке перемикання фільтрів не має
 * малювати відповідь на попередній запит поверх свіжої.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], refreshMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const run = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const v = await load();
      if (my === seq.current) {
        setData(v);
        setError(null);
      }
    } catch (err) {
      if (my === seq.current) setError(err);
    } finally {
      if (my === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void run();
    if (!refreshMs) return;
    // Фонове оновлення лише для видимої вкладки: прихована панель не має
    // смикати базу щоп'ять секунд.
    const t = setInterval(() => { if (document.visibilityState === 'visible') void run(); }, refreshMs);
    return () => clearInterval(t);
  }, [run, refreshMs]);

  return { data, error, loading, reload: run };
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'Сервер не відповідає.';
    if (err.status === 401) return 'Потрібен вхід — оновіть сторінку.';
    const base = err.detail ?? err.code;
    return err.problems.length ? `${base}: ${err.problems.join('; ')}` : base;
  }
  return err instanceof Error ? err.message : String(err);
}

export function ErrorBox({ error, title = 'Не вдалося' }: { error: unknown; title?: string }) {
  if (!error) return null;
  const problems = error instanceof ApiError ? error.problems : [];
  return (
    <div role="alert" className="rounded-control border border-critical/40 bg-critical/8 px-3 py-2 text-sm text-critical">
      <strong className="font-semibold">{title}.</strong>{' '}
      {problems.length ? (
        <ul className="mt-1 list-disc pl-5">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      ) : (
        errorText(error)
      )}
    </div>
  );
}

export function Section({ title, aside, children, className }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('grid gap-3', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {aside && <div className="flex flex-wrap items-center gap-2 text-sm text-ink-secondary">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: 'ok' | 'caution' | 'critical' }) {
  return (
    <Card variant="raised" padding="md" className="grid gap-1">
      <span className="text-xs text-ink-tertiary">{label}</span>
      <span
        className={cn(
          'text-2xl font-semibold tabular-nums',
          tone === 'ok' && 'text-ok', tone === 'caution' && 'text-caution', tone === 'critical' && 'text-critical',
        )}
      >
        {value}
      </span>
      {hint && <span className="text-xs text-ink-secondary">{hint}</span>}
    </Card>
  );
}

export function Loading({ what = 'Завантаження' }: { what?: string }) {
  return <p className="text-sm text-ink-tertiary">{what}…</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-control border border-dashed border-line px-3 py-6 text-center text-sm text-ink-tertiary">{children}</p>;
}

/** Таблиця з горизонтальною прокруткою всередині — сторінка вбік не їде. */
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-x-auto rounded-surface border border-line', className)}>
      <table className="w-full border-collapse text-sm [&_td]:border-t [&_td]:border-line [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:font-medium [&_th]:text-ink-tertiary [&_thead]:bg-sunken">
        {children}
      </table>
    </div>
  );
}

export function Select({
  label, value, onChange, options, className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  className?: string;
}) {
  return (
    <label className={cn('grid gap-1 text-xs text-ink-tertiary', className)}>
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-control border border-line bg-sunken px-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-focus"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

/** Смуга «використано / стеля». */
export function Meter({ used, cap }: { used: number | null; cap: number }) {
  const ratio = used === null ? 0 : Math.min(1, used / cap);
  const tone = ratio >= 1 ? 'bg-critical' : ratio >= 0.8 ? 'bg-caution' : 'bg-accent';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-chip" role="meter" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={used ?? 0}>
      <div className={cn('h-full rounded-full', tone)} style={{ width: `${ratio * 100}%` }} />
    </div>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre className={cn('overflow-x-auto rounded-control border border-line bg-sunken p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-ink', className)}>
      {children}
    </pre>
  );
}
