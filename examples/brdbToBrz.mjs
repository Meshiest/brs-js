// Convert a .brdb world database to a .brz archive.
// Usage: node examples/brdbToBrz.mjs <in.brdb> <out.brz>
import { existsSync, writeFileSync } from 'node:fs';
import { lib } from './openWorld.mjs';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath || !inPath.endsWith('.brdb')) {
  console.error('usage: node examples/brdbToBrz.mjs <in.brdb> <out.brz>');
  process.exit(1);
}
if (!existsSync(inPath)) {
  console.error(`file does not exist: ${inPath}`);
  process.exit(1);
}

const { Brdb, brdb } = lib;
const db = await Brdb.open(inPath);
// The current revision of the database as a pending tree, written straight
// into a .brz container (blobs stored raw; pass a compress option to
// writeBrzContainer for zstd).
const bytes = brdb.writeBrzContainer(db.toPending());
db.close();
writeFileSync(outPath, bytes);
console.log(`${outPath} written (${bytes.length} bytes)`);
