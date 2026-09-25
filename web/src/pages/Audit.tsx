import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Tag,
} from '@exo/kit-ui';
import { useState } from 'react';
import { api, type ChangeSummary, type CheckResult, type DocKind } from '../api';
import { Diff } from '../components/Diff';
import { Empty, ErrorBox, Loading, Select, useLoad } from '../components/ui';
import { when } from '../format';
import { navigate, pathOf } from '../router';

export const KIND: Record<DocKind, string> = { settings: 'налаштування', catalog: 'реєстр', stub: 'заглушка' };

export function Audit({ params }: { params: URLSearchParams }) {
  const kind = (params.get('kind') ?? '') as DocKind | '';
  return (
    <div className="grid gap-5">
      <p className="text-sm text-ink-secondary">
        Кожна зміна налаштувань, реєстру й заглушки з панелі: хто, коли, різниця. Відкат — нова зміна, історія не
        переписується. Правка файла руками (vim) сюди окремим рядком не потрапляє, але видна в «до» наступної зміни.
      </p>
      <Select
        label="Що"
        value={kind}
        onChange={(v) => navigate(pathOf('audit', null, { kind: v }), true)}
        options={[{ value: '', label: 'усе' }, ...Object.entries(KIND).map(([value, label]) => ({ value, label }))]}
        className="w-56"
      />
      <History kind={kind || null} />
    </div>
  );
}

/** Історія змін з відкатом — і на сторінці аудиту, і під редактором документа. */
export function History({ kind, onRestored, limit = 50 }: { kind: DocKind | null; onRestored?: () => void; limit?: number }) {
  const [before, setBefore] = useState<number | null>(null);
  const q = new URLSearchParams({ limit: String(limit), ...(kind ? { kind } : {}), ...(before ? { before: String(before) } : {}) });
  const { data, error, reload } = useLoad(() => api<{ items: ChangeSummary[] }>(`/history?${q}`), [q.toString()]);
  const [open, setOpen] = useState<number | null>(null);
  const [restore, setRestore] = useState<{ change: ChangeSummary; which: 'before' | 'after'; preview: CheckResult | null; error: unknown; busy: boolean } | null>(null);

  async function ask(change: ChangeSummary, which: 'before' | 'after') {
    setRestore({ change, which, preview: null, error: null, busy: true });
    try {
      const preview = await api<CheckResult>(`/history/${change.id}/preview`, { method: 'POST', body: { which } });
      setRestore({ change, which, preview, error: null, busy: false });
    } catch (err) {
      setRestore({ change, which, preview: null, error: err, busy: false });
    }
  }

  async function confirm() {
    if (!restore) return;
    setRestore({ ...restore, busy: true });
    try {
      await api(`/history/${restore.change.id}/restore`, { method: 'POST', body: { which: restore.which } });
      setRestore(null);
      await reload();
      onRestored?.();
    } catch (err) {
      setRestore({ ...restore, busy: false, error: err });
    }
  }

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  if (data.items.length === 0) return <Empty>{before ? 'Далі нічого.' : 'Змін з панелі ще не було.'}</Empty>;

  return (
    <div className="grid gap-2">
      <ul className="grid gap-2">
        {data.items.map((c) => (
          <li key={c.id} className="rounded-surface border border-line">
            <button
              type="button"
              className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-sm hover:bg-lift"
              aria-expanded={open === c.id}
              onClick={() => setOpen(open === c.id ? null : c.id)}
            >
              <span className="text-ink-tertiary tabular-nums">#{c.id}</span>
              <span className="text-ink-secondary">{when(c.at)}</span>
              <Tag tone="neutral">{KIND[c.kind]}</Tag>
              {c.action === 'restore' && <Tag tone="caution">відкат{c.restored_from ? ` #${c.restored_from}` : ''}</Tag>}
              <span className="font-medium">{c.actor}</span>
              <span className="min-w-0 flex-1 truncate text-ink-secondary">{c.note ?? ''}</span>
              <span className="text-xs text-ink-tertiary">
                +{c.diff.split('\n').filter((l) => l.startsWith('+')).length} −{c.diff.split('\n').filter((l) => l.startsWith('-')).length}
              </span>
            </button>
            {open === c.id && (
              <div className="grid gap-3 border-t border-line p-3">
                <Diff text={c.diff} />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void ask(c, 'before')}>Відкотити цю зміну</Button>
                  <Button size="sm" variant="ghost" onClick={() => void ask(c, 'after')}>Повернути цю версію</Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        {before && <Button size="sm" variant="ghost" onClick={() => setBefore(null)}>← найновіші</Button>}
        {data.items.length >= limit && <Button size="sm" onClick={() => setBefore(data.items.at(-1)!.id)}>Старіші</Button>}
      </div>

      <Dialog open={restore !== null} onOpenChange={(v) => { if (!v) setRestore(null); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {restore?.which === 'before' ? `Відкотити зміну #${restore?.change.id}` : `Повернути версію #${restore?.change.id}`}
            </DialogTitle>
            <DialogDescription>
              {KIND[restore?.change.kind ?? 'catalog']}: так зміниться чинний вміст. Запишеться новою зміною з посиланням на #{restore?.change.id}.
            </DialogDescription>
          </DialogHeader>
          <ErrorBox error={restore?.error} />
          {restore?.preview && !restore.preview.ok && (
            <p role="alert" className="text-sm text-critical">Цей вміст непридатний: {restore.preview.problems.join('; ')}</p>
          )}
          {restore?.preview && (restore.preview.unchanged ? <p className="text-sm">Чинний вміст уже такий — змінювати нічого.</p> : <Diff text={restore.preview.diff} />)}
          {!restore?.preview && !restore?.error && <Loading what="Рахую різницю" />}
          <DialogFooter>
            <Button onClick={() => setRestore(null)}>Скасувати</Button>
            <Button
              variant="primary"
              disabled={!restore?.preview?.ok || restore.preview.unchanged || restore.busy}
              onClick={() => void confirm()}
            >
              {restore?.busy ? 'Записую…' : 'Застосувати'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
