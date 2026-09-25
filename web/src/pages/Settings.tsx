import {
  Button, Card, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input,
} from '@exo/kit-ui';
import { useEffect, useState } from 'react';
import { api, type CheckResult, type DocView } from '../api';
import { Diff } from '../components/Diff';
import { ErrorBox, Loading, Mono, Section, Table, useLoad } from '../components/ui';
import { n } from '../format';
import { History } from './Audit';
import { formOf, overridesOf, type Form } from '../settingsForm';

export function Settings() {
  const doc = useLoad(() => api<DocView>('/docs/settings'), []);
  const [form, setForm] = useState<Form | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [purge, setPurge] = useState<string | null>(null);

  useEffect(() => {
    if (doc.data?.overrides && form === null) setForm(formOf(doc.data.overrides, doc.data.products ?? []));
  }, [doc.data, form]);

  if (!doc.data || !form) return doc.error ? <ErrorBox error={doc.error} /> : <Loading />;
  const d = doc.data.defaults!;
  const eff = doc.data.effective!;
  const text = JSON.stringify(overridesOf(form), null, 2);

  async function review() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<CheckResult>('/docs/settings/check', { method: 'POST', body: { text } });
      if (!r.ok) setError({ message: r.problems.join('; ') });
      setCheck(r);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      const r = await api<{ id: number | null }>('/docs/settings', { method: 'PUT', body: { text, note } });
      setCheck(null);
      setNote('');
      setSaved(r.id ? `Збережено як зміну #${r.id}; діє одразу.` : 'Змін немає.');
      setForm(null);
      await doc.reload();
      setHistoryKey((k) => k + 1);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function purgeNow() {
    setPurge('Чищу…');
    try {
      const r = await api<{ contentCleared: number; rowsDeleted: number }>('/journal/purge', { method: 'POST' });
      setPurge(`Вмісту стерто: ${n(r.contentCleared)}, рядків видалено: ${n(r.rowsDeleted)}.`);
    } catch (err) {
      setPurge(null);
      setError(err);
    }
  }

  const field = (value: string, onChange: (v: string) => void, placeholder: string, label: string) => (
    <Input size="sm" type="number" min={0} inputMode="numeric" aria-label={label} value={value} placeholder={placeholder}
      onChange={(e) => { onChange(e.target.value); setSaved(null); }} className="w-32" />
  );

  return (
    <div className="grid gap-8">
      <p className="text-sm text-ink-secondary">
        Порожнє поле — діє значення з <code>.env</code> (показане сірим). Збереження пише рядок аудиту з різницею й
        відкатом; стелі й журнал підхоплюють зміну одразу, без рестарту.
      </p>

      <Section title="Денні стелі" aside="доба UTC; перевищення — 429 budget_exhausted, продукт передає людині">
        <Card variant="flat" padding="md" className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm text-ink-secondary">
            Продукт за добу (спільна)
            {field(form.capProduct, (v) => setForm({ ...form, capProduct: v }), String(d.capProduct), 'стеля продукту')}
          </label>
          <label className="grid gap-1 text-sm text-ink-secondary">
            Один гаманець (subject) за добу (спільна)
            {field(form.capSubject, (v) => setForm({ ...form, capSubject: v }), String(d.capSubject), 'стеля гаманця')}
          </label>
        </Card>
        <Table>
          <thead><tr><th>продукт</th><th>стеля продукту</th><th>стеля гаманця</th><th>діє зараз</th></tr></thead>
          <tbody>
            {Object.entries(form.products).map(([p, v]) => {
              const now = eff.caps.products[p] ?? { product: eff.caps.product, subject: eff.caps.subject };
              const set = (patch: Partial<typeof v>) => setForm({ ...form, products: { ...form.products, [p]: { ...v, ...patch } } });
              return (
                <tr key={p}>
                  <td className="font-medium">{p}</td>
                  <td>{field(v.product, (x) => set({ product: x }), form.capProduct || String(d.capProduct), `${p}: стеля продукту`)}</td>
                  <td>{field(v.subject, (x) => set({ subject: x }), form.capSubject || String(d.capSubject), `${p}: стеля гаманця`)}</td>
                  <td className="text-ink-secondary tabular-nums">{n(now.product)} / {n(now.subject)}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Section>

      <Section title="Журнал запитів">
        <Card variant="flat" padding="md" className="grid gap-4 sm:grid-cols-3">
          <label className="grid gap-1 text-sm text-ink-secondary">
            Зберігати вміст (повідомлення й відповіді)
            <select
              value={form.storeContent}
              onChange={(e) => { setForm({ ...form, storeContent: e.target.value as Form['storeContent'] }); setSaved(null); }}
              className="h-8 w-44 rounded-control border border-line bg-sunken px-2 text-sm text-ink"
            >
              <option value="">як у .env ({d.storeContent ? 'так' : 'ні'})</option>
              <option value="true">так</option>
              <option value="false">ні</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm text-ink-secondary">
            Строк вмісту, днів (0 — без строку)
            {field(form.contentDays, (v) => setForm({ ...form, contentDays: v }), String(d.contentDays), 'строк вмісту')}
          </label>
          <label className="grid gap-1 text-sm text-ink-secondary">
            Строк рядка журналу, днів (0 — без строку)
            {field(form.retentionDays, (v) => setForm({ ...form, retentionDays: v }), String(d.retentionDays), 'строк рядка')}
          </label>
        </Card>
        <p className="text-xs text-ink-tertiary">
          Вміст — це і повідомлення клієнтів teamself та exointel. Вимкнене «зберігати» діє на нові запити; старий вміст
          стирається за строком. Чистка йде пакетами раз на добу.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void purgeNow()}>Почистити за чинним строком зараз</Button>
          {purge && <span className="text-sm text-ink-secondary">{purge}</span>}
        </div>
      </Section>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void review()}>Зберегти…</Button>
        <Button variant="ghost" disabled={busy} onClick={() => { setForm(formOf(doc.data!.overrides!, doc.data!.products ?? [])); setSaved(null); }}>Скинути правки</Button>
        {saved && <span className="text-sm text-ok">{saved}</span>}
      </div>
      <ErrorBox error={error} />
      <details className="text-sm text-ink-secondary">
        <summary className="cursor-pointer">Перекриття як JSON (те, що лежить у базі)</summary>
        <Mono className="mt-2">{doc.data.text}</Mono>
      </details>

      <Section title="Історія налаштувань">
        <History key={historyKey} kind="settings" limit={10} onRestored={() => { setForm(null); void doc.reload(); }} />
      </Section>

      <Dialog open={check !== null && check.ok} onOpenChange={(v) => { if (!v) setCheck(null); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Зберегти налаштування</DialogTitle>
            <DialogDescription>{check?.unchanged ? 'Змін немає.' : 'Різниця з чинним перекриттям:'}</DialogDescription>
          </DialogHeader>
          {check && !check.unchanged && <Diff text={check.diff} />}
          <label className="grid gap-1 text-sm text-ink-secondary">
            Навіщо (необов’язково)
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </label>
          <DialogFooter>
            <Button onClick={() => setCheck(null)}>Скасувати</Button>
            <Button variant="primary" disabled={busy || check?.unchanged} onClick={() => void save()}>{busy ? 'Записую…' : 'Зберегти'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
