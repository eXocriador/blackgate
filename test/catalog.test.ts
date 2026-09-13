import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseCatalog, CatalogError } from '../src/catalog/index.js';

const base = `
version: 1
pools:
  p1: { upstream: a, probe: m1 }
  p2: { upstream: b, probe: m3 }
models:
  - { id: m1, pool: p1 }
  - { id: m2, pool: p1 }
  - { id: m3, pool: p2 }
tiers:
  fast: [m1, m3]
`;

function problemsOf(text: string): string[] {
  try {
    parseCatalog(text);
    return [];
  } catch (err) {
    if (err instanceof CatalogError) return err.problems;
    throw err;
  }
}

describe('реєстр', () => {
  it('приймає драбину, що перетинає пули', () => {
    const cat = parseCatalog(base);
    expect(cat.tiers.get('fast')!.map((m) => m.id)).toEqual(['m1', 'm3']);
    expect(cat.models.get('m1')!.timeout_ms).toBe(30_000);
  });

  /**
   * ДОКАЗ ІНВАРІАНТА. Це той самий конфіг, що живе в проді teamself: основна і
   * запасна моделі в одному метрованому пулі. Сервіс мусить його відхилити, а
   * не прийняти мовчки, і повідомлення мусить назвати ОБИДВІ сходинки.
   */
  it('відхиляє драбину, обидві сходинки якої в одному пулі, і називає обидві', () => {
    const problems = problemsOf(base.replace('fast: [m1, m3]', 'fast: [m1, m2]'));
    expect(problems.length).toBeGreaterThan(0);
    const msg = problems.join('\n');
    expect(msg).toContain('"m1"');
    expect(msg).toContain('"m2"');
    expect(msg).toContain('p1');
    expect(msg).toContain('ОДНОМУ пулі');
  });

  it('ловить однопулову пару в середині довгої драбини, не лише на початку', () => {
    const text = base
      .replace('  - { id: m3, pool: p2 }', '  - { id: m3, pool: p2 }\n  - { id: m4, pool: p2 }')
      .replace('fast: [m1, m3]', 'fast: [m1, m3, m4]');
    const msg = problemsOf(text).join('\n');
    expect(msg).toContain('"m3"');
    expect(msg).toContain('"m4"');
  });

  it('дозволяє повернення до свого пулу через чужий: [p1, p2, p1]', () => {
    const text = base.replace('fast: [m1, m3]', 'fast: [m1, m3, m2]');
    expect(problemsOf(text)).toEqual([]);
  });

  it('не пускає виведену з експлуатації модель у драбину', () => {
    const text = base
      .replace('  - { id: m3, pool: p2 }', '  - { id: m3, pool: p2 }\n  - { id: m4, pool: p2, retired: true }')
      .replace('fast: [m1, m3]', 'fast: [m1, m4]');
    expect(problemsOf(text).join('\n')).toContain('retired');
  });

  it('не пускає виведену з експлуатації модель у пробу пулу', () => {
    const text = base
      .replace('p2: { upstream: b, probe: m3 }', 'p2: { upstream: b, probe: m4 }')
      .replace('  - { id: m3, pool: p2 }', '  - { id: m3, pool: p2 }\n  - { id: m4, pool: p2, retired: true }');
    expect(problemsOf(text).join('\n')).toContain('текстом-надгробком');
  });

  it('не пускає пробу з чужого пулу', () => {
    const text = base.replace('p2: { upstream: b, probe: m3 }', 'p2: { upstream: b, probe: m1 }');
    expect(problemsOf(text).join('\n')).toContain('чуже здоров\'я');
  });

  it('збирає ВСІ проблеми за один прохід, а не падає на першій', () => {
    const text = base.replace('fast: [m1, m3]', 'fast: [m1, m2]\n  slow: [m3, nema]');
    expect(problemsOf(text).length).toBeGreaterThanOrEqual(2);
  });

  it('відхиляє посилання на неоголошений пул', () => {
    expect(problemsOf(base.replace('- { id: m2, pool: p1 }', '- { id: m2, pool: pX }')).join('\n'))
      .toContain('pX');
  });

  it('драбина з однієї сходинки — не драбина', () => {
    expect(problemsOf(base.replace('fast: [m1, m3]', 'fast: [m1]')).length).toBeGreaterThan(0);
  });
});

describe('продовий catalog.yaml', () => {
  /**
   * Файл, що поїде в прод, проходить ті самі ворота. Без цього тесту інваріант
   * стеріг би вигадані реєстри з тестів, а справжній — ні.
   */
  it('розбирається і задовольняє інваріант', () => {
    const cat = parseCatalog(readFileSync(new URL('../catalog.yaml', import.meta.url), 'utf8'));
    expect(cat.poolNames).toContain('gemini-premium');
    expect(cat.poolNames).toContain('gemini-lite');
    expect(cat.tierNames.sort()).toEqual(['agent', 'capable', 'fast']);
  });

  it('кожна драбина справді переходить у пул, який 2026-09-13 відповідав', () => {
    const cat = parseCatalog(readFileSync(new URL('../catalog.yaml', import.meta.url), 'utf8'));
    for (const [tier, rungs] of cat.tiers) {
      const pools = new Set(rungs.map((r) => r.pool));
      expect(pools.size, `тир ${tier} мусить мати >1 пул`).toBeGreaterThan(1);
      // Пул `gemini-premium` лежав цілком; драбина мусить мати куди зійти.
      expect([...pools].some((p) => p !== 'gemini-premium'), `тир ${tier}`).toBe(true);
    }
  });

  it('жодна сходинка не є моделлю, що віддає підроблений 200', () => {
    const cat = parseCatalog(readFileSync(new URL('../catalog.yaml', import.meta.url), 'utf8'));
    for (const rungs of cat.tiers.values()) {
      for (const m of rungs) expect(m.retired).toBe(false);
    }
  });
});
