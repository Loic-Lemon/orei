import { isAlias, isMap, isNode, isScalar, parseDocument, visit } from 'yaml';
export type OreiAsset = {
  kind: 'icon' | 'image';
  mediaType: 'image/svg+xml' | 'image/png';
  encoding: 'text' | 'base64';
  data: string;
  [key: string]: unknown;
};
export type OreiDocument = {
  format: 'orei'; version: 1; source: string; css: string;
  assets: Record<string, OreiAsset>;
  [key: string]: unknown;
};

const maxFile = 8 * 1024 * 1024;
const maxAsset = 2 * 1024 * 1024;
const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function validate(value: unknown): asserts value is OreiDocument {
  if (!object(value) || value.format !== 'orei' || value.version !== 1 || typeof value.source !== 'string' || typeof value.css !== 'string' || !object(value.assets)) throw new Error('Invalid or unsupported .orei document');
  const entries = Object.entries(value.assets);
  if (entries.length > 256) throw new Error('Too many assets');
  for (const [name, asset] of entries) {
    // Asset references are nonempty strings of at most 512 UTF-8 bytes.
    if (!name || utf8Bytes(name) > 512 || !object(asset) || typeof asset.data !== 'string' || utf8Bytes(asset.data) > maxAsset) throw new Error('Invalid asset');
    // shortcut: embedded assets are unsupported until SVG and PNG content can be safely validated.
    throw new Error('Unsupported embedded asset');
  }
}

function validateJson(value: unknown): void {
  const active = new Set<object>();
  const walk = (item: unknown, depth: number): void => {
    if (depth > 64) throw new Error('Invalid metadata');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) return;
    if (typeof item !== 'object') throw new Error('Invalid JSON value');
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error('Invalid JSON object');
    if (active.has(item)) throw new Error('Cyclic JSON value');
    active.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key === 'symbol') || 'toJSON' in item) throw new Error('Invalid JSON object');
    if (array && keys.length !== item.length + 1) throw new Error('Invalid JSON array');
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = descriptors[key as string];
      if (!descriptor.enumerable || !('value' in descriptor) || (array && (!/^(0|[1-9]\d*)$/.test(key as string) || Number(key) >= item.length))) throw new Error('Invalid JSON property');
      walk(descriptor.value, depth + 1);
    }
    active.delete(item);
  };
  walk(value, 0);
}

export function decodeOrei(text: string): OreiDocument {
  if (utf8Bytes(text) > maxFile) throw new Error('.orei document is too large');
  const parsed = parseDocument(text, {uniqueKeys:true, merge:false, resolveKnownTags:false, schema:'core'});
  if (parsed.errors.length || parsed.warnings.length) throw new Error('Invalid .orei YAML');
  visit(parsed, (_key, node, path) => {
    if (path.length > 128 || isAlias(node) || (isNode(node) && node.tag)) throw new Error('Unsupported .orei YAML');
    if (isMap(node) && node.items.some(pair => !isScalar(pair.key) || typeof pair.key.value !== 'string')) throw new Error('Invalid YAML mapping key');
    if (isMap(node) && node.items.some(pair => isScalar(pair.key) && pair.key.type === 'PLAIN' && pair.key.value === '<<')) throw new Error('Unsupported YAML merge key');
  });
  const value: unknown = parsed.toJS({maxAliasCount:0});
  validateJson(value);
  validate(value);
  return value;
}

export function encodeOrei(document: OreiDocument): string {
  validateJson(document);
  validate(document);
  const output = `${JSON.stringify(document, null, 2)}\n`;
  decodeOrei(output);
  return output;
}
