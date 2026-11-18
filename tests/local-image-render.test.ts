import { describe, expect, test } from 'vitest';
import { renderDiagram } from '../src/rendering';

const settings = { mode: 'fixed' as const, width: 320 };

/** A data URL carrying the PNG signature and an IHDR header with these dimensions. */
function png(width: number, height: number): string {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

describe('local image resolution diagnostics', () => {
  test('a remote image reference is blocked instead of being fetched', async () => {
    await expect(renderDiagram({ source: 'flowchart LR\n A@{ img: "https://example.test/a.png" }', css: '', assets: {} }, settings))
      .rejects.toThrow(/Remote image blocked: https:\/\/example\.test\/a\.png/);
  });

  test('a missing local image names the reference and how to restore it', async () => {
    await expect(renderDiagram({ source: 'flowchart LR\n A@{ img: "assets/missing.png" }', css: '', assets: {} }, settings))
      .rejects.toThrow(/Missing local image: assets\/missing\.png\. Import it into this document, or keep the file beside a paired \.mmd and reopen it\./);
  });

  test('inline image data in the source is diagnosed rather than silently rendered', async () => {
    await expect(renderDiagram({ source: 'flowchart LR\n A@{ img: "data:image/png;base64,AAAA" }', css: '', assets: {} }, settings))
      .rejects.toThrow('Inline image data is not supported in diagram source');
  });

  test('a stored body that is not a PNG data URL is refused', async () => {
    await expect(renderDiagram({ source: 'flowchart LR\n A@{ img: "assets/photo.png" }', css: '', assets: { 'assets/photo.png': '<svg/>' } }, settings))
      .rejects.toThrow(/Unsupported local image: assets\/photo\.png/);
  });

  test('an encoded image beyond the character limit is refused', async () => {
    const oversized = png(8, 8) + 'A'.repeat(2_000_001);
    await expect(renderDiagram({ source: 'flowchart LR\n A@{ img: "assets/photo.png" }', css: '', assets: { 'assets/photo.png': oversized } }, settings))
      .rejects.toThrow(/Local image is too large: assets\/photo\.png/);
  });

  test('a carried PNG becomes a self-contained data URL in the rendered output', async () => {
    const data = png(8, 8);
    const result = await renderDiagram({ source: 'flowchart LR\n A@{ img: "assets/photo.png", w: 8, h: 8 }', css: '', assets: { 'assets/photo.png': data } }, settings);
    const svg = new DOMParser().parseFromString(result.svg, 'image/svg+xml');
    expect(svg.querySelector('image')?.getAttribute('href')).toBe(data);
    expect(result.svg).not.toContain('assets/photo.png');
  });
});
