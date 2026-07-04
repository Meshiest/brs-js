// Parser for the plaintext .schema sources: enum, variant, and struct
// declarations. Enum keys are qualified ("EFoo::Bar"); enum values accept
// decimal, 0b binary, and 0x hex literals with optional underscores.
import type { PropDesc } from './schema';

export interface SchemaData {
  enums: Map<string, Map<string, number>>;
  variants: Map<string, string[]>;
  structs: Map<string, Map<string, PropDesc>>;
}

const stripComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ');

// Identifier, optionally qualified: EBRColorSpace::Linear
const IDENT = String.raw`[A-Za-z_]\w*(?:::\w+)*`;

function parseIntLiteral(raw: string): number {
  const t = raw.replace(/_/g, '');
  if (t.startsWith('0b')) return parseInt(t.slice(2), 2);
  if (t.startsWith('0x')) return parseInt(t.slice(2), 16);
  return parseInt(t, 10);
}

export function parseSchemaText(text: string): SchemaData {
  const src = stripComments(text);
  const enums = new Map<string, Map<string, number>>();
  const variants = new Map<string, string[]>();
  const structs = new Map<string, Map<string, PropDesc>>();
  const declRe = /\b(enum|variant|struct)\s+([A-Za-z0-9_]+)\s*\{([^{}]*)\}/g;
  const enumEntryRe = new RegExp(
    String.raw`^(${IDENT})\s*=\s*(-?\d+(?:_\d+)*|0b[01]+(?:_[01]+)*|0x[0-9a-fA-F]+(?:_[0-9a-fA-F]+)*)$`
  );
  const memberRe = new RegExp(String.raw`^${IDENT}$`);
  const propRe = new RegExp(
    String.raw`^(\w+)\s*:\s*(\w+)\s*(\[\s*(flat)?\s*\])?$`
  );

  let lastEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = declRe.exec(src))) {
    if (src.slice(lastEnd, match.index).trim() !== '')
      throw new Error(`brdb: unexpected schema text before ${match[2]}`);
    lastEnd = declRe.lastIndex;
    const [, keyword, name, body] = match;
    const items = body
      .split(',')
      .map(s => s.trim())
      .filter(s => s !== '');

    if (keyword === 'enum') {
      const values = new Map<string, number>();
      for (const item of items) {
        const m = enumEntryRe.exec(item);
        if (!m)
          throw new Error(`brdb: cannot parse enum entry '${item}' in ${name}`);
        values.set(m[1], parseIntLiteral(m[2]));
      }
      enums.set(name, values);
    } else if (keyword === 'variant') {
      const members: string[] = [];
      for (const item of items) {
        if (!memberRe.test(item))
          throw new Error(
            `brdb: cannot parse variant member '${item}' in ${name}`
          );
        members.push(item);
      }
      variants.set(name, members);
    } else {
      const props = new Map<string, PropDesc>();
      for (const item of items) {
        const m = propRe.exec(item);
        if (!m)
          throw new Error(
            `brdb: cannot parse struct property '${item}' in ${name}`
          );
        const [, prop, ty, isArray, isFlat] = m;
        props.set(
          prop,
          isArray
            ? { kind: isFlat ? 'flatarray' : 'array', type: ty }
            : { kind: 'type', type: ty }
        );
      }
      structs.set(name, props);
    }
  }
  if (src.slice(lastEnd).trim() !== '')
    throw new Error('brdb: trailing unparsed schema text');
  return { enums, variants, structs };
}
