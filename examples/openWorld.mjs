// Shared example helper: load the built library and open a .brz or .brdb
// world. Build the library first: just build
import { existsSync, readFileSync } from 'node:fs';

const dist = new URL('../dist/dist.mjs', import.meta.url);
if (!existsSync(dist)) {
  console.error('dist/dist.mjs not found; run `just build` first');
  process.exit(1);
}

/** The built library module (named exports plus the brdb namespace). */
export const lib = await import(dist.href);

/** Open a world file; returns { reader, db } where db is null for .brz. */
export async function openWorld(file, usage) {
  if (!file) {
    console.error(`usage: ${usage}`);
    process.exit(1);
  }
  if (!existsSync(file)) {
    console.error(`file does not exist: ${file}`);
    process.exit(1);
  }
  if (file.endsWith('.brdb')) {
    const db = await lib.Brdb.open(file);
    return { db, reader: db.worldReader() };
  }
  return {
    db: null,
    reader: lib.WorldReader.from(new Uint8Array(readFileSync(file))),
  };
}
