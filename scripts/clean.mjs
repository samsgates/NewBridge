import { rm } from 'node:fs/promises';
import { glob } from 'node:fs/promises';

for await (const path of glob('packages/*/dist')) {
  await rm(path, { recursive: true, force: true });
}
