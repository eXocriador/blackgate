import {
  Button, Card, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input,
} from '@exo/kit-ui';
import { useEffect, useState } from 'react';
import { api, type CheckResult, type DocView } from '../api';
import { Diff } from '../components/Diff';
import { ErrorBox, Loading, Section, useLoad } from '../components/ui';
import { when } from '../format';
import { History } from './Audit';

const ABOUT = {
  catalog: {
    file: 'config/catalog.yaml',
    text: 'Пули, моделі (таймаути, ціни), драбини тирів. Перевіряється тим самим розбором, що й на старті: сусідні сходинки — різні пули, проба належить своєму пулу й не виведена. Прийняте застосовується одразу, без рестарту.',
  },
  stub: {
    file: 'config/stub.yaml',
    text: 'Кому заглушка відповідає замість моделей (always — завжди, fallback — лише коли драбина не дала нічого) і готові відповіді за продуктом, гаманцем, тиром і назвою схеми. Файла немає або routes: [] — вимкнено для всіх.',
  },
} as const;

/**
 * Редактор реєстру чи заглушки. «Перевірити» — розбір і різниця без запису;
 * «Зберегти» — той самий розбір на сервері, атомарний запис і рядок аудиту.
 * Непридатне не зберігається взагалі — як і на старті процесу.
 */
export function DocEditor({ kind }: { kind: 'catalog' | 'stub' }) {
  const doc = useLoad(() => api<DocView>(`/docs/${kind}`), [kind]);
  const [text, setText] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);

  useEffect(() => {
    if (doc.data && text === null) setText(doc.data.text);
  }, [doc.data, text]);

  const dirty = doc.data !== null && text !== null && text !== doc.data.text;

  async function runCheck(): Promise<CheckResult | null> {
    if (text === null) return null;
    setBusy(true);
    setError(null);
    try {
      const r = await api<CheckResult>(`/docs/${kind}/check`, { method: 'POST', body: { text } });
      setCheck(r);
      return r;
    } catch (err) {
      setError(err);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ id: number | null; doc: DocView }>(`/docs/${kind}`, { method: 'PUT', body: { text, note } });
      setConfirm(false);
      setNote('');
      setCheck(null);
      setSaved(r.id ? `Збережено як зміну #${r.id}.` : 'Змін немає — нічого не записано.');
      setText(r.doc.text);
      await doc.reload();
      setHistoryKey((k) => k + 1);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!doc.data) return doc.error ? <ErrorBox error={doc.error} /> : <Loading />;

  return (
    <div className="grid gap-6">
      <p className="text-sm text-ink-secondary">{ABOUT[kind].text}</p>
      {doc.data.drift && (
        <Card variant="flat" padding="md" className="border-caution/50 text-sm">
          <strong className="text-caution">Файл змінено повз панель</strong> після останньої зміни з неї
          {doc.data.lastChange ? ` (#${doc.data.lastChange.id}, ${when(doc.data.lastChange.at)})` : ''}. Правка руками
          потрапить у «до» наступного збереження.
        </Card>
      )}

      <Section
        title={ABOUT[kind].file}
        aside={doc.data.lastChange ? `остання зміна з панелі: #${doc.data.lastChange.id} · ${doc.data.lastChange.actor} · ${when(doc.data.lastChange.at)}` : 'змін з панелі ще не було'}
      >
        <textarea
          aria-label={ABOUT[kind].file}
          value={text ?? ''}
          onChange={(e) => { setText(e.target.value); setCheck(null); setSaved(null); }}
          spellCheck={false}
          rows={28}
          className="w-full rounded-control border border-line bg-sunken p-3 font-mono text-xs leading-relaxed text-ink focus-visible:outline-2 focus-visible:outline-focus"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void runCheck()} disabled={busy || !dirty}>Перевірити</Button>
          <Button
            variant="primary"
            disabled={busy || !dirty}
            onClick={async () => { const r = await runCheck(); if (r?.ok && !r.unchanged) setConfirm(true); }}
          >
            Зберегти…
          </Button>
          <Button variant="ghost" disabled={busy || !dirty} onClick={() => { setText(doc.data!.text); setCheck(null); }}>
            Скинути правки
          </Button>
          {saved && <span className="text-sm text-ok">{saved}</span>}
          {!dirty && !saved && <span className="text-sm text-ink-tertiary">Без правок.</span>}
        </div>
        <ErrorBox error={error} />
        {check && !check.ok && (
          <div role="alert" className="rounded-control border border-critical/40 bg-critical/8 px-3 py-2 text-sm text-critical">
            <strong className="font-semibold">Непридатний — не збережеться ({check.problems.length}):</strong>
            <ul className="mt-1 list-disc pl-5">{check.problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </div>
        )}
        {check?.ok && <p className="text-sm text-ok">Придатний. {check.unchanged ? 'Змін немає.' : 'Різниця з чинним:'}</p>}
        {check && !check.unchanged && <Diff text={check.diff} />}
      </Section>

      <Section title="Історія змін">
        <History key={historyKey} kind={kind} limit={10} onRestored={() => { setText(null); void doc.reload(); }} />
      </Section>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Зберегти {ABOUT[kind].file}</DialogTitle>
            <DialogDescription>Застосується одразу. У аудиті — ваше ім'я, час, різниця і відкат.</DialogDescription>
          </DialogHeader>
          {check && <Diff text={check.diff} />}
          <label className="grid gap-1 text-sm text-ink-secondary">
            Навіщо (необов’язково, видно в аудиті)
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="напр. таймаут flash-lite 20 с" />
          </label>
          <ErrorBox error={error} />
          <DialogFooter>
            <Button onClick={() => setConfirm(false)}>Скасувати</Button>
            <Button variant="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Записую…' : 'Зберегти'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
