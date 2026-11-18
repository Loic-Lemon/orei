import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { copyImage, copySvg, copySource } from '../src/output';
import type { Snapshot } from '../src/rendering';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));

beforeEach(() => { native.invoke.mockReset(); });

// jsdom cannot rasterize (ticket 12 boundary), so the webview-only raster seam is stubbed:
// object URLs, image decode and canvas encoding must be present for the clipboard payload
// plumbing to run, and the encoded bytes come from the stub, not a real rasterization.
beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:orei'), revokeObjectURL: vi.fn() }));
  HTMLImageElement.prototype.decode = async () => {};
  // Pele measures text through canvas.getContext('2d'); jsdom normally returns null and
  // Pele falls back to its estimator, so the stub must not hand back a bare context.
  (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).getContext = () => ({
    fillRect: () => {}, drawImage: () => {}, measureText: () => ({ width: 0 }),
  });
  (HTMLCanvasElement.prototype as unknown as Record<string, unknown>).toBlob = (done: (blob: Blob | null) => void) =>
    done(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  const canvas = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  delete canvas.getContext;
  delete canvas.toBlob;
  const image = HTMLImageElement.prototype as unknown as Record<string, unknown>;
  delete image.decode;
});

const snapshot: Snapshot = { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', width: 10, height: 10 };

test('SVG markup is copied as plain text through its own command payload', async () => {
  native.invoke.mockResolvedValue(undefined);
  await copySvg(snapshot);
  expect(native.invoke).toHaveBeenCalledOnce();
  expect(native.invoke.mock.calls[0][0]).toBe('copy_output_text');
  expect(native.invoke.mock.calls[0][1]).toEqual({ text: snapshot.svg });
});

test('Mermaid source is copied as plain text regardless of rendering state', async () => {
  native.invoke.mockResolvedValue(undefined);
  await copySource('flowchart TD\n  A --> B');
  expect(native.invoke).toHaveBeenCalledWith('copy_output_text', { text: 'flowchart TD\n  A --> B' });
});

test('an unoffered scale is refused before any clipboard image work', async () => {
  await expect(copyImage(snapshot, 3)).rejects.toThrow(/scale/i);
  await expect(copyImage(snapshot, 0)).rejects.toThrow(/scale/i);
  expect(native.invoke).not.toHaveBeenCalled();
});

test('the copied image carries PNG-encoded bytes from the same raster pipeline', async () => {
  native.invoke.mockResolvedValue(undefined);
  await copyImage(snapshot, 2, true);
  expect(native.invoke).toHaveBeenCalledOnce();
  expect(native.invoke.mock.calls[0][0]).toBe('copy_output_image');
  const bytes = native.invoke.mock.calls[0][1].bytes as number[];
  expect(bytes.slice(0, 8)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('an SVG clipboard failure is reported instead of claiming success', async () => {
  native.invoke.mockRejectedValue(new Error('pasteboard denied'));
  await expect(copySvg(snapshot)).rejects.toThrow(/pasteboard denied/);
});
