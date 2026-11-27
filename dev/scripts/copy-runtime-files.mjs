import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const source = resolve('src/snapshots/snapshot-core.mjs');
const destination = resolve('dist/src/snapshots/snapshot-core.mjs');
await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
