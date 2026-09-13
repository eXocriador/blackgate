import { describe, it, expect } from 'vitest';
import { parseProductKeys, readKey, KeyConfigError } from '../src/http/auth.js';

const KEYS = 'exointel:aaaaaaaaaaaaaaaaaaaa,teamself:bbbbbbbbbbbbbbbbbbbb';

describe('ключі продуктів', () => {
  it('ключ називає продукт', () => {
    const k = parseProductKeys(KEYS);
    expect(k.resolve('aaaaaaaaaaaaaaaaaaaa')).toBe('exointel');
    expect(k.resolve('bbbbbbbbbbbbbbbbbbbb')).toBe('teamself');
  });

  it('чужий ключ — нічий', () => {
    expect(parseProductKeys(KEYS).resolve('cccccccccccccccccccc')).toBeNull();
    expect(parseProductKeys(KEYS).resolve(null)).toBeNull();
    expect(parseProductKeys(KEYS).resolve('')).toBeNull();
  });

  it('секрет із двокрапкою всередині лишається цілим', () => {
    const k = parseProductKeys('p:aaaa:bbbb:cccc:dddd');
    expect(k.resolve('aaaa:bbbb:cccc:dddd')).toBe('p');
  });

  it('один секрет двом продуктам — відмова: облік не розділився б', () => {
    expect(() => parseProductKeys('a:zzzzzzzzzzzzzzzzzzzz,b:zzzzzzzzzzzzzzzzzzzz'))
      .toThrow(KeyConfigError);
  });

  it('короткий секрет — відмова, і в тексті немає самого секрету', () => {
    try {
      parseProductKeys('a:short');
      throw new Error('мало впасти');
    } catch (err) {
      expect(err).toBeInstanceOf(KeyConfigError);
      expect((err as Error).message).not.toContain('short');
    }
  });

  it('порожній PRODUCT_KEYS — відмова', () => {
    expect(() => parseProductKeys('')).toThrow(KeyConfigError);
    expect(() => parseProductKeys('   ')).toThrow(KeyConfigError);
  });

  it('запис без двокрапки — відмова', () => {
    expect(() => parseProductKeys('простотекст')).toThrow(KeyConfigError);
  });
});

describe('читання ключа із заголовків', () => {
  it('Bearer', () => expect(readKey({ authorization: 'Bearer abc' })).toBe('abc'));
  it('bearer у будь-якому регістрі', () => expect(readKey({ authorization: 'bearer abc' })).toBe('abc'));
  it('X-Api-Key', () => expect(readKey({ 'x-api-key': 'abc' })).toBe('abc'));
  it('нічого', () => expect(readKey({})).toBeNull());
  it('Basic не приймається', () => expect(readKey({ authorization: 'Basic abc' })).toBeNull());
});
