import type { CatalogFile, ModelSpec, PoolSpec } from './schema.js';

/**
 * Перевірки реєстру, яких не виражає схема, бо вони про ЗВ'ЯЗКИ між записами.
 *
 * Головна з них — та, заради якої існує сервіс: сусідні сходинки драбини мусять
 * лежати в різних пулах. Це перевірка конфігу, а не пам'ять про інцидент, і
 * різниця тут не стилістична. Пам'ять уже двічі не спрацювала: спершу teamself
 * і exointel отримали однакову структуру драбини, потім teamself виніс запасну
 * модель у `.env`, і жоден із двох кроків не мав місця, де це можна було б
 * помітити. Перевірка має таке місце — старт.
 */

export class CatalogError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`реєстр непридатний:\n  - ${problems.join('\n  - ')}`);
    this.name = 'CatalogError';
    this.problems = problems;
  }
}

export interface ResolvedModel extends ModelSpec {
  poolSpec: PoolSpec;
}

export interface ResolvedCatalog {
  readonly pools: ReadonlyMap<string, PoolSpec>;
  readonly models: ReadonlyMap<string, ResolvedModel>;
  /** Тир → сходинки, уже звірені з реєстром. */
  readonly tiers: ReadonlyMap<string, readonly ResolvedModel[]>;
  readonly tierNames: readonly string[];
  readonly poolNames: readonly string[];
}

/**
 * Звести файл у структуру для рантайму, зібравши ВСІ проблеми, а не впавши на
 * першій. Оператор, що правит реєстр, має побачити повний список за один
 * запуск: інакше виправлення одного рядка відкриває наступну помилку, і
 * перезапуск коштує стільки ж, скільки перший.
 */
export function resolveCatalog(file: CatalogFile): ResolvedCatalog {
  const problems: string[] = [];

  const pools = new Map<string, PoolSpec>(Object.entries(file.pools));
  const models = new Map<string, ResolvedModel>();

  for (const m of file.models) {
    if (models.has(m.id)) {
      problems.push(`модель "${m.id}" оголошена двічі`);
      continue;
    }
    const poolSpec = pools.get(m.pool);
    if (!poolSpec) {
      problems.push(`модель "${m.id}" посилається на пул "${m.pool}", якого немає в pools`);
      continue;
    }
    models.set(m.id, { ...m, poolSpec });
  }

  // Проба пулу мусить існувати, належати цьому пулу і бути придатною. Проба
  // з чужого пулу міряла б чуже здоров'я і мовчки; проба виведеною з
  // експлуатації моделлю (та, що віддає 200 з текстом-надгробком) назвала б
  // здоровим будь-що.
  for (const [name, pool] of pools) {
    const probe = models.get(pool.probe);
    if (!probe) {
      problems.push(`пул "${name}": проба "${pool.probe}" не оголошена в models`);
      continue;
    }
    if (probe.pool !== name) {
      problems.push(
        `пул "${name}": проба "${pool.probe}" належить пулу "${probe.pool}" — міряла б чуже здоров'я`,
      );
    }
    if (probe.retired) {
      problems.push(
        `пул "${name}": проба "${pool.probe}" позначена retired — вона віддає 200 з текстом-надгробком і назве здоровим будь-що`,
      );
    }
  }

  const tiers = new Map<string, readonly ResolvedModel[]>();
  for (const [tier, rungs] of Object.entries(file.tiers)) {
    const resolved: ResolvedModel[] = [];
    let broken = false;

    for (const [i, id] of rungs.entries()) {
      const m = models.get(id);
      if (!m) {
        problems.push(`тир "${tier}", сходинка ${i}: моделі "${id}" немає в models`);
        broken = true;
        continue;
      }
      if (m.retired) {
        problems.push(
          `тир "${tier}", сходинка ${i}: модель "${id}" позначена retired — вона віддає HTTP 200 із текстом-надгробком, і продукт показав би його як відповідь`,
        );
        broken = true;
        continue;
      }
      resolved.push(m);
    }
    if (broken) continue;

    problems.push(...crossPoolProblems(tier, resolved));
    tiers.set(tier, resolved);
  }

  if (problems.length > 0) throw new CatalogError(problems);

  return {
    pools,
    models,
    tiers,
    tierNames: [...tiers.keys()],
    poolNames: [...pools.keys()],
  };
}

/**
 * ІНВАРІАНТ: сусідні сходинки драбини лежать у різних пулах.
 *
 * Чому саме сусідні, а не «усі різні»: драбина [A(п1), B(п2), C(п1)] цілком
 * розумна — коли п1 вичерпаний, до C справа не дійде, бо B уже відповів, а
 * коли вичерпаний п2, C рятує. Забороняти таке означало б забороняти
 * повернення до дешевшої моделі свого пулу. А от [A(п1), B(п1)] не рятує ні в
 * якому разі: це рівно те, що лежало в teamself.
 *
 * Повідомлення називає ОБИДВІ сходинки і пул — інакше оператор із десятирядковою
 * драбиною знає, що щось не так, і не знає що.
 */
function crossPoolProblems(tier: string, rungs: readonly ResolvedModel[]): string[] {
  const out: string[] = [];

  for (let i = 1; i < rungs.length; i++) {
    const prev = rungs[i - 1]!;
    const curr = rungs[i]!;
    if (prev.pool === curr.pool) {
      out.push(
        `тир "${tier}": сходинки ${i - 1} ("${prev.id}") і ${i} ("${curr.id}") лежать в ОДНОМУ пулі "${curr.pool}" — ` +
          `коли пул вичерпається, обидві підуть у 429 разом, і драбина не врятує. ` +
          `Наступна сходинка після "${prev.id}" мусить бути з іншого пулу.`,
      );
    }
  }

  // Драбина з одного пулу цілком (усі сходинки в ньому) — окремий випадок, який
  // сусідство вже спіймало вище, але сказати це прямо дешевше, ніж змусити
  // читати три однакові рядки.
  const distinct = new Set(rungs.map((r) => r.pool));
  if (rungs.length > 1 && distinct.size === 1) {
    out.push(
      `тир "${tier}": уся драбина (${rungs.length} сходинок) лежить в одному пулі "${[...distinct][0]}" — це не драбина, а список синонімів`,
    );
  }

  return out;
}
