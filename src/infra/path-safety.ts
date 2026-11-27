import { lstat, mkdir } from 'node:fs/promises';
import { join, parse, relative, resolve, sep } from 'node:path';

/** Create a local storage directory one component at a time, rejecting links. */
export async function ensureOrdinaryDirectory(directory: string, unsafePath: () => Error): Promise<void> {
  const absolute = resolve(directory);
  const { root } = parse(absolute);
  let current = root;

  const rootInfo = await lstat(root).catch(() => { throw unsafePath(); });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw unsafePath();

  for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, component);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw unsafePath();
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw unsafePath();
      }
      try {
        info = await lstat(current);
      } catch {
        throw unsafePath();
      }
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw unsafePath();
  }
}
