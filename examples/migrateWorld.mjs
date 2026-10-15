// Upgrade an EA3 world to the current save format.
// Usage: node examples/migrateWorld.mjs <input.brz|input.brdb> <output.brz>
// A world that is already in the current format is copied unchanged.
import { existsSync, writeFileSync } from 'node:fs';
import { lib, openWorld } from './openWorld.mjs';

const [input, output] = process.argv.slice(2);
const usage = 'node examples/migrateWorld.mjs <input> <output.brz>';
if (!output) {
  console.error(`usage: ${usage}`);
  process.exit(1);
}
if (existsSync(output)) {
  console.error(`${output} already exists`);
  process.exit(1);
}
const { reader, db } = await openWorld(input, usage);
const { brdb } = lib;
writeFileSync(output, brdb.writeBrzContainer(brdb.toLatest(reader)));
db?.close();
console.log(`wrote ${output}`);
