// Write a world containing one red brick to example_brick.brz and
// example_brick.brdb, then read both back.
// Build the library first: just build
import { existsSync, writeFileSync } from 'node:fs';

const dist = new URL('../dist/dist.mjs', import.meta.url);
if (!existsSync(dist)) {
  console.error('dist/dist.mjs not found; run `just build` first');
  process.exit(1);
}
const { Brdb, WorldReader, writeBrzLegacy } = await import(dist.href);

const save = {
  bricks: [{ size: [5, 5, 6], position: [0, 0, 6], color: [255, 0, 0] }],
};
const options = { bundle: { description: 'Example World' } };

// .brz is a single deterministic archive
const bytes = writeBrzLegacy(save, options);
writeFileSync('example_brick.brz', bytes);
console.log(`example_brick.brz written (${bytes.length} bytes)`);

const [brzBrick] = [...WorldReader.from(bytes).bricks()];
console.log('.brz read back:', brzBrick.position, brzBrick.color);

// .brdb is a revisioned database; every save adds a revision (unchanged
// files are shared between revisions, so rerunning this example only adds
// a revision row)
const db = await Brdb.openOrCreate('example_brick.brdb');
db.save('Write example brick', save, options);
console.log(
  'example_brick.brdb revisions:',
  db.revisions().map(r => `${r.revisionId}: ${r.description}`)
);

const [dbBrick] = [...db.worldReader().bricks()];
console.log('.brdb read back:', dbBrick.position, dbBrick.color);
db.close();
