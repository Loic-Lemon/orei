import { assetKind, type DocumentAssets } from './document-assets';
import { validateIconBody } from './icon-safety';
import { imageDataProblem, relativeImageReference } from './image-import';

/** One document asset as stored beside a paired `.mmd` document. */
export type PairedAsset = {
  kind: 'icon' | 'image';
  mediaType: 'image/svg+xml' | 'image/png';
  encoding: 'text' | 'data-url';
  data: string;
};
/** Where the stylesheet and asset index for a paired document came from. */
export type PairState = { base: string; cssCompanion: boolean; assetsCompanion: boolean };
/** The complete file-group snapshot sent to the native paired writer. */
export type PairedSnapshot = { source: string; css: string | null; assets: string | null };

export const pairedAssetFile = 'orei-assets';
const format = 'orei-paired-assets';
const version = 1;
const maxIndex = 8 * 1024 * 1024;
const maxAsset = 2 * 1024 * 1024;
const maxAssets = 256;
const maxReference = 512;
const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function checkReference(reference: string): void {
  if (!reference || utf8Bytes(reference) > maxReference || /[\u0000-\u001f\u007f]/.test(reference)) throw new Error('Invalid document asset reference');
}

function imageData(reference: string, data: string): void {
  // Same type and encoded-size limits as the import control and the renderer.
  const problem = imageDataProblem(reference, data);
  if (problem) throw new Error(problem);
}

function iconData(reference: string, data: string): void {
  if (utf8Bytes(data) > maxAsset) throw new Error(`Icon definition is too large: ${reference}`);
  // Same rules, limits and messages as import and render: one validation path.
  validateIconBody(reference, data);
}

/** Serializes the renderer's asset strings into the adjacent, typed asset index. */
export function encodePairedAssets(assets: Readonly<DocumentAssets>): string {
  const entries = Object.entries(assets);
  if (entries.length > maxAssets) throw new Error('Too many document assets');
  const encoded: Record<string, PairedAsset> = {};
  // defineProperty keeps keys like __proto__ as own properties instead of hitting the
  // prototype setter, which would silently drop them from the rewritten index.
  const define = (reference: string, asset: PairedAsset) =>
    void Object.defineProperty(encoded, reference, { value: asset, enumerable: true, configurable: true, writable: true });
  for (const [reference, data] of entries) {
    checkReference(reference);
    if (typeof data !== 'string') throw new Error(`Invalid document asset: ${reference}`);
    // The shared classifier decides which typed entry an in-memory value becomes, so the
    // codec and the editor cannot disagree about what is an icon body and what is an image.
    const kind = assetKind(data);
    if (kind === 'image') {
      imageData(reference, data);
      define(reference, { kind: 'image', mediaType: 'image/png', encoding: 'data-url', data });
    } else if (kind === 'icon') {
      iconData(reference, data);
      define(reference, { kind: 'icon', mediaType: 'image/svg+xml', encoding: 'text', data });
    } else {
      throw new Error(`Invalid document asset: ${reference}`);
    }
  }
  return `${JSON.stringify({ format, version, assets: encoded }, null, 2)}\n`;
}

/** Validates an adjacent asset index before any of it is used for rendering or saving. */
export function decodePairedAssets(text: string): DocumentAssets {
  if (utf8Bytes(text) > maxIndex) throw new Error('The document asset index is too large');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Invalid document asset index'); }
  if (!plainObject(value) || value.format !== format || value.version !== version || !plainObject(value.assets)) {
    throw new Error('Invalid or unsupported document asset index');
  }
  const entries = Object.entries(value.assets);
  if (entries.length > maxAssets) throw new Error('Too many document assets');
  const assets: DocumentAssets = {};
  for (const [reference, raw] of entries) {
    checkReference(reference);
    if (!plainObject(raw) || typeof raw.data !== 'string') throw new Error(`Invalid document asset: ${reference}`);
    const { kind, mediaType, encoding, data } = raw;
    if (kind === 'icon' && mediaType === 'image/svg+xml' && encoding === 'text') iconData(reference, data);
    else if (kind === 'image' && mediaType === 'image/png' && encoding === 'data-url') imageData(reference, data);
    else throw new Error(`Invalid document asset: ${reference}`);
    Object.defineProperty(assets, reference, { value: data, enumerable: true, configurable: true, writable: true });
  }
  return assets;
}

const imageReference = /\bimg\s*:\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)')/g;

/** Image references from Mermaid source. Incomplete or unsupported references are kept as text. */
export function imageReferences(source: string): string[] {
  const references: string[] = [];
  for (const match of source.matchAll(imageReference)) {
    const reference = (match[1] ?? match[2]).trim();
    if (relativeImageReference(reference) && !references.includes(reference)) references.push(reference);
  }
  return references;
}

/**
 * Builds the complete save snapshot. The in-memory stylesheet is intentionally not written
 * until it is edited (or a companion already exists), so opening a standalone `.mmd` never
 * creates a companion. Existing assets are never dropped from the index.
 */
export function pairedSnapshot(document: { source: string; css: string; assets: DocumentAssets }, pair: PairState): PairedSnapshot {
  return {
    source: document.source,
    css: pair.cssCompanion ? document.css : null,
    assets: pair.assetsCompanion || Object.keys(document.assets).length ? encodePairedAssets(document.assets) : null,
  };
}
