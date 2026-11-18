import { describe, expect, test } from 'vitest';
import {
  ImageCollisionError,
  MAX_IMAGE_DATA_URL,
  MAX_IMAGE_PIXELS,
  imageDataProblem,
  imageReferenceFromFilename,
  importImageProblem,
  importLocalImage,
  pngSize,
  relativeImageReference,
} from '../src/image-import';
import { IMPORTED_ASSET_LIMIT } from '../src/document-assets';
import { pngDataUrl } from './png-fixture';

describe('local image references', () => {
  test('accepts relative PNG paths below the document and rejects everything else', () => {
    for (const reference of ['photo.png', 'assets/photo.png', 'assets/nested/Photo.PNG', 'with space.png']) {
      expect(relativeImageReference(reference), reference).toBe(true);
    }
    for (const reference of ['', '/absolute.png', '../outside.png', 'assets/../outside.png', 'assets\\photo.png', 'https://example.test/photo.png', 'data:image/png;base64,AAAA', 'assets/photo.svg', 'assets/']) {
      expect(relativeImageReference(reference), reference).toBe(false);
    }
    expect(relativeImageReference('x'.repeat(513))).toBe(false);
  });

  test('derives a default reference from the picked file name', () => {
    expect(imageReferenceFromFilename('Photo.PNG')).toBe('Photo.png');
    expect(imageReferenceFromFilename('assets/delivery van.jpeg')).toBe('delivery van.png');
    expect(imageReferenceFromFilename('')).toBe('image.png');
    expect(imageReferenceFromFilename('.png')).toBe('image.png');
  });
});

describe('local image data limits', () => {
  test('reads the PNG header dimensions without decoding pixels', () => {
    expect(pngSize(pngDataUrl(64, 48))).toEqual({ width: 64, height: 48 });
    expect(pngSize('data:image/png;base64,AAAA')).toBeUndefined();
    expect(pngSize('data:image/svg+xml;base64,AAAA')).toBeUndefined();
  });

  test('the stored asset gate checks the type and the encoded size only', () => {
    expect(imageDataProblem('a.png', 'data:image/png;base64,AAAA')).toBeUndefined();
    // The paired index historically accepts unpadded base64 fixtures; the codec is not the decoder.
    expect(imageDataProblem('a.png', 'data:image/png;base64,iVBORw0KGgo=')).toBeUndefined();
    expect(imageDataProblem('a.png', 'data:image/svg+xml;base64,AAAA')).toContain('Unsupported local image: a.png');
    expect(imageDataProblem('a.png', 'https://example.test/a.png')).toContain('Unsupported local image');
    expect(imageDataProblem('a.png', 'data:image/png;base64,AAAA' + 'A'.repeat(MAX_IMAGE_DATA_URL))).toContain('too large');
  });

  test('import validates a readable PNG header and the decoded dimension limits', () => {
    expect(importImageProblem('a.png', pngDataUrl(64, 48))).toBeUndefined();
    expect(importImageProblem('a.png', 'data:image/png;base64,iVBORw0KGgo=')).toContain('not a readable PNG');
    expect(importImageProblem('a.png', pngDataUrl(0, 48))).toContain('not a readable PNG');
    expect(importImageProblem('wide.png', pngDataUrl(4097, 1))).toContain('wide.png is 4097 × 1 px');
    expect(importImageProblem('tall.png', pngDataUrl(1, 4097))).toContain('tall.png is 1 × 4097 px');
    expect(importImageProblem('dense.png', pngDataUrl(4096, 4096))).toContain(`limit is 4096 px per side and ${MAX_IMAGE_PIXELS.toLocaleString('en-US')} pixels`);
  });
});

describe('importing a selected PNG', () => {
  test('uses the provided reference and leaves the existing map untouched', () => {
    const existing = {};
    const image = importLocalImage({ reference: 'assets/photo.png', filename: 'photo.png', data: pngDataUrl(8, 8), existing });
    expect(image).toEqual({ reference: 'assets/photo.png', data: pngDataUrl(8, 8) });
    expect(existing).toEqual({});
  });

  test('falls back to the picked file name when no reference is provided', () => {
    expect(importLocalImage({ reference: '  ', filename: 'Beach Photo.png', data: pngDataUrl(8, 8), existing: {} }).reference).toBe('Beach Photo.png');
  });

  test('refuses unsafe references, collisions and the import asset cap without changing the map', () => {
    const existing = { 'assets/photo.png': pngDataUrl(8, 8) };
    expect(() => importLocalImage({ reference: '../outside.png', filename: 'photo.png', data: pngDataUrl(8, 8), existing })).toThrow('Invalid image reference');
    expect(() => importLocalImage({ reference: 'assets/photo.png', filename: 'photo.png', data: pngDataUrl(8, 8), existing })).toThrow(ImageCollisionError);
    const full = Object.fromEntries(Array.from({ length: IMPORTED_ASSET_LIMIT }, (_, index) => [`icon:${index}`, '<svg/>']));
    expect(() => importLocalImage({ reference: 'one.png', filename: 'one.png', data: pngDataUrl(8, 8), existing: full })).toThrow(`maximum of ${IMPORTED_ASSET_LIMIT} assets`);
    expect(existing['assets/photo.png']).toBe(pngDataUrl(8, 8));
  });

  test('rejects unsupported, oversized and unreadable image content', () => {
    expect(() => importLocalImage({ filename: 'photo.png', data: 'data:image/svg+xml;base64,AAAA', existing: {} })).toThrow('Unsupported local image');
    expect(() => importLocalImage({ filename: 'photo.png', data: pngDataUrl(8, 8) + 'A'.repeat(MAX_IMAGE_DATA_URL), existing: {} })).toThrow('too large');
    expect(() => importLocalImage({ filename: 'photo.png', data: 'data:image/png;base64,AAAA', existing: {} })).toThrow('not a readable PNG');
    expect(() => importLocalImage({ filename: 'photo.png', data: pngDataUrl(8192, 8192), existing: {} })).toThrow('8192 × 8192 px');
  });
});
