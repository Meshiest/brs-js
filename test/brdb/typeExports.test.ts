// Compile-time check: every type referenced by a public BrdbSchema (or
// other exported class) method signature must be importable from
// src/brdb/index.ts without reaching into an internal module. This file's
// only job is to typecheck; `npx tsc -p test/tsconfig.json` fails to
// compile if any of these imports regress to unresolved names.
import { expect, test } from 'vitest';
import type {
  BrdbVariant,
  EmbeddedSchemaName,
  SchemaData,
  SchemaSource,
  SchemaSourceProp,
} from '../../src/brdb';
import { BrdbSchema } from '../../src/brdb';

test('barrel exports the types referenced by public BrdbSchema signatures', () => {
  const source: SchemaSource = { enums: {}, variants: {}, structs: {} };
  const schema = BrdbSchema.fromData(source);
  const prop: SchemaSourceProp = 'u8';
  const variant: BrdbVariant = { $variant: 'f64', value: 0 };
  const merged: SchemaData = schema.extractStructsTransitive([]);
  schema.merge(merged);
  const name: EmbeddedSchemaName = 'BRSavedGlobalDataSoA';
  expect([prop, variant.$variant, name]).toEqual(['u8', 'f64', name]);
});
