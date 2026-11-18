// A selected local PNG becomes a document asset stored as a data URL, keyed by the
// relative reference the diagram uses (`@{ img: "assets/photo.png" }`). document-assets.ts
// owns the map shape and paired-document.ts writes the same key into the adjacent asset
// index, so a reopen does not need the original image file. This module owns the image
// limits and messages shared by the import control, the renderer, and the paired codec;
// standalone Markdown keeps refusing to save while any asset is present.
import { addAsset, IMPORTED_ASSET_LIMIT, type DocumentAssets } from './document-assets';

export const MAX_IMAGE_DATA_URL = 2_000_000;
export const MAX_IMAGE_SIDE = 4096;
export const MAX_IMAGE_PIXELS = 16_000_000;

const MAX_REFERENCE = 512;
const PNG_DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

export type ImportedImage = { reference: string; data: string };

export class ImageCollisionError extends Error {
  reference: string;
  constructor(reference: string) {
    super(`An image is already stored as ${reference} in this document. Choose a different reference or remove the existing image; nothing was changed.`);
    this.name = 'ImageCollisionError';
    this.reference = reference;
  }
}

/**
 * True for a reference the native reader may resolve inside the document's directory:
 * a relative `.png` path without `..`, a leading slash, a scheme, a backslash or control
 * characters. Inline `data:` URLs are not document references.
 */
export function relativeImageReference(reference: string): boolean {
  return Boolean(reference)
    && utf8Bytes(reference) <= MAX_REFERENCE
    && !reference.startsWith('/')
    && !reference.includes('\\')
    && !/[\r\n\u0000]/.test(reference)
    && !/^[a-z][a-z0-9+.-]*:/i.test(reference)
    && reference.toLowerCase().endsWith('.png')
    && reference.split('/').every(part => part && part !== '.' && part !== '..');
}

/** Derives a safe relative reference from a picked file name; the user can edit it. */
export function imageReferenceFromFilename(value: string): string {
  const base = value.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '').replace(/[\u0000-\u001f\u007f]/g, '-').trim();
  return base ? `${base}.png` : 'image.png';
}

/**
 * The type and encoded-size gate every stored image must pass. Kept text-only (no pixel
 * decoding) so the paired codec can validate an index during a read.
 */
export function imageDataProblem(reference: string, data: string): string | undefined {
  if (!PNG_DATA_URL.test(data)) return `Unsupported local image: ${reference}. Only PNG data URLs are stored in a document.`;
  if (data.length > MAX_IMAGE_DATA_URL) return `Local image is too large: ${reference}. The encoded PNG must stay within ${MAX_IMAGE_DATA_URL.toLocaleString('en-US')} characters.`;
  return undefined;
}

/** Width and height from the PNG signature and IHDR header, when the data is a PNG. */
export function pngSize(data: string): { width: number; height: number } | undefined {
  const encoded = PNG_DATA_URL.exec(data)?.[1];
  if (!encoded) return undefined;
  let header: Uint8Array;
  // Signature (8) + chunk length (4) + "IHDR" (4) + width (4) + height (4) fit in 32 base64 characters.
  try { header = Uint8Array.from(atob(encoded.slice(0, 32)), character => character.charCodeAt(0)); }
  catch { return undefined; }
  if (header.length < 24 || !PNG_SIGNATURE.every((byte, index) => header[index] === byte)) return undefined;
  const view = new DataView(header.buffer);
  if (view.getUint32(8) !== 13 || String.fromCharCode(header[12], header[13], header[14], header[15]) !== 'IHDR') return undefined;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Import-time validation: the shared data-URL gate plus a readable header and the decoded
 * dimension limits the renderer enforces. A rejected file never touches the document.
 */
export function importImageProblem(reference: string, data: string): string | undefined {
  const encoded = imageDataProblem(reference, data);
  if (encoded) return encoded;
  const size = pngSize(data);
  if (!size || !size.width || !size.height) return `Unsupported local image: ${reference}. The file is not a readable PNG image.`;
  if (Math.max(size.width, size.height) > MAX_IMAGE_SIDE || size.width * size.height > MAX_IMAGE_PIXELS) {
    return `Local image ${reference} is ${size.width} × ${size.height} px; the supported limit is ${MAX_IMAGE_SIDE} px per side and ${MAX_IMAGE_PIXELS.toLocaleString('en-US')} pixels in total. Choose a smaller image; nothing was changed.`;
  }
  return undefined;
}

/** Validates a selected PNG and reserves its reference; the caller stores the body. */
export function importLocalImage(input: { reference?: string; filename: string; data: string; existing: DocumentAssets }): ImportedImage {
  const requested = (input.reference ?? '').trim();
  const reference = requested || imageReferenceFromFilename(input.filename);
  if (!relativeImageReference(reference)) {
    throw new Error(`Invalid image reference ${JSON.stringify(reference)}: use a relative path ending in .png below the .mmd file, without "..", a leading slash, a drive letter, a URL or a backslash.`);
  }
  if (Object.hasOwn(input.existing, reference)) throw new ImageCollisionError(reference);
  if (Object.keys(input.existing).length >= IMPORTED_ASSET_LIMIT) {
    throw new Error(`This document already carries the maximum of ${IMPORTED_ASSET_LIMIT} assets, so ${reference} cannot be imported. Paired documents may hold more via the adjacent asset index; remove an asset or save the document as a pair first.`);
  }
  const problem = importImageProblem(reference, input.data);
  if (problem) throw new Error(problem);
  return { reference, data: input.data };
}
