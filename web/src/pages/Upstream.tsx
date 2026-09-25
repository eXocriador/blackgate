import { Button, Card, Tag } from '@exo/kit-ui';
import { api, type UpstreamView } from '../api';
import { ErrorBox, Loading, Mono, Section, Table, useLoad } from '../components/ui';
import { when } from '../format';

const ENABLE = `remote-management:
  allow-remote: true
  secret-key: "<довгий випадковий рядок>"`;

/**
 * Підписки: вхід в Antigravity / Claude / Codex живе в Management Center
 * двигуна під VibeConduit (cli-proxy-api-plus, MIT), а не тут. Панель лише
 * показує, що там, і веде туди.
 */
export function Upstream() {
  const { data, error, reload, loading } = useLoad(() => api<UpstreamView>('/upstream'), []);
  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;

  return (
    <div className="grid gap-6">
      <p className="text-sm text-ink-secondary">
        Входи до провайдерів (Antigravity, Claude, Codex) робляться в Management Center двигуна, що стоїть під
        VibeConduit, — OAuth із вставкою адреси повернення на віддаленому сервері. blackgate читає звідти стан
        акаунтів і квоти й сам нічого не логінить.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {data.panelUrl ? (
          <Button asChild variant="primary"><a href={data.panelUrl} target="_blank" rel="noreferrer">Відкрити Management Center ↗</a></Button>
        ) : (
          <span className="text-sm text-ink-tertiary">Адреси Management Center немає (UPSTREAM_PANEL_URL).</span>
        )}
        <Button onClick={() => void reload()} disabled={loading}>Оновити</Button>
      </div>

      {data.state === 'no_key' || data.state === 'disabled' ? (
        <Section title="Management API не ввімкнено">
          <Card variant="flat" padding="md" className="grid gap-3 text-sm">
            <p>
              {data.state === 'disabled' ? `Двигун відповідає: ${data.detail}.` : 'У blackgate немає ключа UPSTREAM_MANAGEMENT_KEY.'}{' '}
              Увімкнути може лише власник — конфіг лежить під <code>/home/exo</code>, агентові недоступний:
            </p>
            <ol className="grid list-decimal gap-2 pl-5">
              <li>У <code>/home/exo/.local/share/vibeconduit/config.yaml</code> додати (VibeConduit цей файл не перезаписує):<Mono className="mt-1">{ENABLE}</Mono></li>
              <li><code>systemctl --user restart vibeconduit</code> від користувача <code>exo</code>.</li>
              <li>Той самий ключ — у <code>/srv/products/blackgate/.env</code> як <code>UPSTREAM_MANAGEMENT_KEY</code>, потім <code>./deploy.sh</code>.</li>
            </ol>
            <p className="text-ink-tertiary">
              Двигун банить IP на ~30 хв після 5 невдалих ключів — blackgate після першої відмови ключа мовчить 35 хв, тож
              помилка в ключі не забанить сам шлюз.
            </p>
          </Card>
        </Section>
      ) : data.state === 'key_rejected' ? (
        <ErrorBox error={new Error(`Двигун відхилив UPSTREAM_MANAGEMENT_KEY. Наступна спроба не раніше ${when(data.until)} — щоб не впертися в бан IP.`)} title="Ключ не підходить" />
      ) : data.state === 'error' ? (
        <ErrorBox error={new Error(data.detail)} title="Management API не відповів" />
      ) : (
        <>
          <Section title="Акаунти (файли входу)">
            <AuthFiles value={data.authFiles} />
          </Section>
          {data.usage !== null && data.usage !== undefined && (
            <Section title="Облік двигуна">
              <Mono>{JSON.stringify(data.usage, null, 2)}</Mono>
            </Section>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Форма відповіді `auth-files` залежить від версії двигуна; поля звіряються з
 * встановленою, коли API оживе. Тому таблиця — з того, що є в записах, а решта
 * — сирим JSON, а не вгадані колонки.
 */
function AuthFiles({ value }: { value: unknown }) {
  const list = Array.isArray(value) ? value : Array.isArray((value as { files?: unknown })?.files) ? (value as { files: unknown[] }).files : null;
  if (!list) return <Mono>{JSON.stringify(value, null, 2)}</Mono>;
  const rows = list as Array<Record<string, unknown>>;
  const pick = ['provider', 'type', 'email', 'label', 'name', 'status', 'disabled', 'expired', 'modtime', 'updated_at'];
  const cols = pick.filter((k) => rows.some((r) => r[k] !== undefined && r[k] !== null && r[k] !== ''));
  return (
    <div className="grid gap-3">
      <Table>
        <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} className="text-xs">
                  {c === 'status' || c === 'disabled' || c === 'expired'
                    ? <Tag tone={r[c] === true || r[c] === 'error' || r[c] === 'expired' ? 'critical' : 'neutral'}>{String(r[c])}</Tag>
                    : String(r[c] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </Table>
      <details className="text-xs text-ink-tertiary">
        <summary className="cursor-pointer">сирий JSON</summary>
        <Mono className="mt-2">{JSON.stringify(value, null, 2)}</Mono>
      </details>
    </div>
  );
}
