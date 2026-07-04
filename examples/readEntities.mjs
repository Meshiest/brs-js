// Print every entity in a world.
// Usage: node examples/readEntities.mjs <world.brz|world.brdb>
import { openWorld } from './openWorld.mjs';

const { reader, db } = await openWorld(
  process.argv[2],
  'node examples/readEntities.mjs <world.brz|world.brdb>'
);

let count = 0;
for (const e of reader.entities()) {
  count += 1;
  console.log(`${e.typeName} (persistent index ${e.persistentIndex})`);
  console.log(`  location: ${e.location.X}, ${e.location.Y}, ${e.location.Z}`);
  console.log(
    `  frozen: ${e.frozen}, sleeping: ${e.sleeping}, owner: ${e.ownerIndex}`
  );
  if (e.data) console.log('  data:', e.data);
}
console.log(`${count} entities`);
db?.close();
