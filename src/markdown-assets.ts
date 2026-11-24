import { assetKind, type DocumentAssets } from './document-assets';
import { encodePairedAssets } from './paired-document';
import { imageDataProblem } from './image-import';
import { validateIconBody } from './icon-safety';

const marker = '<!-- orei:assets:v1 ';
const close = ' -->';
const LIMIT = 8 * 1024 * 1024;

export type MarkdownAssetManifest = {
  version: 1;
  attachments: string;
  namespace?: string;
  assets: Record<string, { path: string; kind: 'image' | 'icon' }>;
  css?: string;
};
export type MarkdownAssetFile = { path: string; data: string; kind: 'image' | 'icon' | 'css' };

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).byteLength;
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64 = 0xffffffffffffffffn;

/** FNV-1a 64-bit over the NUL-separated parts. The reference is part of the input so two
 * references with identical bytes still address different files; equal content at one
 * reference repeats the same path, which the publisher treats as already published. */
function contentAddress(...parts: string[]): string {
  let hash = FNV_OFFSET;
  for (const byte of encoder.encode(parts.join('\0'))) hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & U64;
  return hash.toString(16).padStart(16, '0');
}

/** One path segment the storage scheme may use; anything outside the class becomes a dash. */
function segment(value: string, fallback: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '-');
  // '.' and '..' spell only allowed characters but are not usable names.
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

/** The reference's last segment as the stored file name, without doubling an extension it
 * already carries, so `assets/photo.png` stays `photo.png` instead of `photo.png.png`. */
function fileName(reference: string, suffix: string): string {
  const base = segment(reference.slice(reference.lastIndexOf('/') + 1), 'file');
  return base.endsWith(`.${suffix}`) ? base : `${base}.${suffix}`;
}

function validateRelativePath(path: string, allowSameFolder = false): void {
  if (allowSameFolder && path === '.') return;
  if (!path || bytes(path) > 1024 || path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)
    || /^[a-z][a-z\d+.-]*:/i.test(path) || path.split('/').some(part => !part || part === '.')) {
    throw new Error('Invalid Markdown attachment path');
  }
}

function parseManifest(text: string): { manifest?: MarkdownAssetManifest; start: number; end: number } {
  const first = text.indexOf(marker);
  if (first < 0) return { start: -1, end: -1 };
  const end = text.indexOf(close, first + marker.length);
  if (end < 0 || text.indexOf(marker, first + marker.length) >= 0) throw new Error('Malformed or ambiguous Orei asset metadata');
  let raw: unknown;
  try { raw = JSON.parse(text.slice(first + marker.length, end)); } catch { throw new Error('Malformed Orei asset metadata'); }
  if (!plain(raw) || raw.version !== 1 || typeof raw.attachments !== 'string' || !plain(raw.assets)) throw new Error('Unsupported Orei asset metadata');
  validateRelativePath(raw.attachments, true);
  if (raw.namespace !== undefined) {
    if (typeof raw.namespace !== 'string') throw new Error('Invalid Markdown asset namespace');
    validateRelativePath(raw.namespace);
  }
  for (const [reference, item] of Object.entries(raw.assets)) {
    if (!plain(item) || typeof item.path !== 'string' || !['image', 'icon'].includes(String(item.kind))) throw new Error(`Invalid Orei asset metadata: ${reference}`);
    validateRelativePath(item.path);
  }
  if (raw.css !== undefined) {
    if (typeof raw.css !== 'string') throw new Error('Invalid external stylesheet metadata');
    validateRelativePath(raw.css);
  }
  return { manifest: raw as MarkdownAssetManifest, start: first, end: end + close.length };
}

/** Builds a note-relative, content-addressed persistence plan; native code must publish
 * files under the user-approved attachments root before writing the returned note text. */
export function planMarkdownAssets(input: {
  text: string; assets: Readonly<DocumentAssets>; attachments: string;
  namespace: string; css?: { externalPath?: string; storagePath?: string; body: string } | null;
}): { text: string; manifest: MarkdownAssetManifest; files: MarkdownAssetFile[] } {
  validateRelativePath(input.attachments, true);
  validateRelativePath(input.namespace);
  const previous = parseManifest(input.text);
  const old = previous.manifest;
  // Files live under a namespace folder addressed by content, so re-saving the same draft
  // rewrites the same paths and never needs a fresh version directory.
  const namespace = segment(input.namespace, 'file');
  const manifest: MarkdownAssetManifest = { version: 1, attachments: input.attachments, namespace: input.namespace, assets: {} };
  const files: MarkdownAssetFile[] = [];
  // Paired codec supplies the shared validations and protects references such as __proto__.
  encodePairedAssets(input.assets);
  for (const [reference, data] of Object.entries(input.assets)) {
    const kind = assetKind(data);
    if (kind !== 'image' && kind !== 'icon') throw new Error(`Unsupported document asset: ${reference}`);
    if (kind === 'image') {
      const problem = imageDataProblem(reference, data);
      if (problem) throw new Error(problem);
    } else validateIconBody(reference, data);
    const suffix = kind === 'image' ? 'png' : 'svg';
    const storagePath = `${namespace}/${contentAddress(reference, data)}/${fileName(reference, suffix)}`;
    const path = input.attachments === '.' ? storagePath : `${input.attachments}/${storagePath}`;
    validateRelativePath(path);
    validateRelativePath(storagePath);
    manifest.assets[reference] = { path, kind };
    files.push({ path: storagePath, data, kind });
  }
  if (input.css) {
    // A stylesheet has no reference of the same shape, so its address lives in its own
    // domain and includes the chosen name to keep distinct stylesheets apart.
    const name = input.css.storagePath ?? input.css.externalPath ?? 'stylesheet.css';
    const storagePath = `${namespace}/${contentAddress('css', name, input.css.body)}/${fileName(name, 'css')}`;
    const externalPath = input.css.externalPath ?? (input.attachments === '.' ? storagePath : `${input.attachments}/${storagePath}`);
    validateRelativePath(externalPath);
    validateRelativePath(storagePath);
    manifest.css = externalPath;
    files.push({ path: storagePath, data: input.css.body, kind: 'css' });
  } else if (input.css === null) {
    // Clearing an external stylesheet removes its reference; old immutable files are retained.
  } else if (old?.css) manifest.css = old.css;
  const json = JSON.stringify(manifest);
  if (bytes(json) > LIMIT || files.some(file => bytes(file.data) > 2 * 1024 * 1024)) throw new Error('Markdown asset metadata or attachment exceeds the supported size');
  const replacement = `${marker}${json}${close}`;
  const text = previous.start < 0
    ? `${input.text}${input.text && !/[\r\n]$/.test(input.text) ? '\n' : ''}\n${replacement}\n`
    : input.text.slice(0, previous.start) + replacement + input.text.slice(previous.end);
  return { text, manifest, files };
}

/** Resolves only validated manifest references; unknown assets remain unhydrated. */
export function markdownAssetPaths(text: string): MarkdownAssetManifest | undefined {
  return parseManifest(text).manifest;
}
