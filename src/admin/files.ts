/**
 * Атомарний запис файла в змонтованій ТЕЦІ: тимчасовий файл поруч + rename.
 *
 * Не `writeFile` поверх наявного: читач реєстру (перечитування за mtime кожні
 * 15 с) міг би застати файл наполовину записаним, а обірваний посередині запис
 * лишив би напівфайл, на якому процес не стартує. rename у межах однієї теки
 * атомарний: читач бачить або старий файл, або новий.
 *
 * Саме тому в контейнер монтується тека, а не файл (README, «Реєстр моделей
 * монтується ТЕКОЮ»): rename створює новий inode, і монт одного файла лишив би
 * контейнер зі старим вмістом назавжди.
 *
 * Права — 0664 явно: umask процесу зрізав би group-write, і власник із хоста
 * (група `srv`) більше не зміг би правити файл руками.
 */
import { open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function writeAtomic(path: string, text: string, mode = 0o664): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fh = await open(tmp, 'wx', mode);
  try {
    await fh.writeFile(text, 'utf8');
    // `open` з mode підкоряється umask; chmod на власному новому файлі — ні.
    await fh.chmod(mode);
    await fh.sync();
  } catch (err) {
    await fh.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw err;
  }
  await fh.close();
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
