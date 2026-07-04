// Convert a .brz archive to a .brdb world database.
// Usage: node examples/brzToBrdb.mjs <in.brz> <out.brdb>
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { lib } from './openWorld.mjs';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath || !outPath.endsWith('.brdb')) {
  console.error('usage: node examples/brzToBrdb.mjs <in.brz> <out.brdb>');
  process.exit(1);
}
if (!existsSync(inPath)) {
  console.error(`file does not exist: ${inPath}`);
  process.exit(1);
}

const { Brdb, brdb } = lib;
const reader = brdb.BrzReader.from(new Uint8Array(readFileSync(inPath)));

// Walk the archive into a pending tree (folders first, then files).
const pending = (path = '') => [
  ...reader.childFolders(path).map(name => [
    name,
    {
      type: 'folder',
      children: pending(path === '' ? name : `${path}/${name}`),
    },
  ]),
  ...reader.childFiles(path).map(name => [
    name,
    {
      type: 'file',
      content: reader.readFile(path === '' ? name : `${path}/${name}`),
    },
  ]),
];

rmSync(outPath, { force: true });
const db = await Brdb.create(outPath);
db.writePending(`Imported from ${basename(inPath)}`, pending());
console.log(
  `${outPath} written;`,
  db.revisions().map(r => `${r.revisionId}: ${r.description}`)
);
db.close();
