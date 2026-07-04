// Print the SQLite schema of a .brdb world database.
// Usage: node examples/readSqliteSchema.mjs <world.brdb>
import { existsSync } from 'node:fs';
import { lib } from './openWorld.mjs';

const file = process.argv[2];
if (!file || !file.endsWith('.brdb')) {
  console.error('usage: node examples/readSqliteSchema.mjs <world.brdb>');
  process.exit(1);
}
if (!existsSync(file)) {
  console.error(`file does not exist: ${file}`);
  process.exit(1);
}

const db = await lib.Brdb.open(file);
console.log(db.sqliteSchema());
db.close();
