import { test, expect } from 'vitest';
import { png, pngDimensions, prepareSvg, type PreparedSvg } from '../src/output';
import type { Snapshot } from '../src/rendering';

const snapshot = (width:number, height:number, svg:string):Snapshot => ({ svg, width, height });

const opaqueSnapshot = snapshot(120, 90,
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90" viewBox="0 0 120 90" data-orei-background="#123456">' +
  '<rect data-orei-canvas="" width="120" height="90" fill="#123456"/><rect width="40" height="40" fill="#b91c1c"/>' +
  '<text>Ordinary label</text></svg>');

test('PNG scale accepts the offered 1x, 2x and 4x choices and rounds dimensions up', () => {
  for (const scale of [1, 2, 4]) {
    expect(pngDimensions(100.25, 50.25, scale)).toEqual({ width: Math.ceil(100.25 * scale), height: Math.ceil(50.25 * scale) });
  }
});

test.each([0, 1.5, 3, 8, -2])('PNG scale %s outside the offered choices is refused before any output', scale => {
  expect(() => pngDimensions(100, 100, scale)).toThrow(/scale/i);
});

test('PNG dimensions beyond the accepted resource limits are refused with a meaningful error', () => {
  expect(() => pngDimensions(16385, 1, 1)).toThrow(/16,384 px per side/);
  expect(() => pngDimensions(1, 16385, 1)).toThrow(/16,384 px per side/);
  expect(() => pngDimensions(16384, 3907, 1)).toThrow(/64 million pixels/);
  expect(() => pngDimensions(16384, 3906, 1)).not.toThrow();
  expect(() => pngDimensions(0, 1, 1)).toThrow();
});

test('document background export keeps the canvas rect and reports the document background', () => {
  const prepared = prepareSvg(opaqueSnapshot, false);
  expect(prepared.background).toBe('#123456');
  const reparsed = new DOMParser().parseFromString(prepared.svg, 'image/svg+xml');
  expect(reparsed.querySelector('[data-orei-canvas]')).not.toBeNull();
  expect(reparsed.querySelector('rect[fill="#b91c1c"]')).not.toBeNull();
  expect(reparsed.querySelector('text')?.textContent).toBe('Ordinary label');
});

test('transparent export removes only the canvas rect and keeps opaque shapes recolor-free', () => {
  const prepared = prepareSvg(opaqueSnapshot, true);
  expect(prepared.background).toBe('#123456');
  const reparsed = new DOMParser().parseFromString(prepared.svg, 'image/svg+xml');
  expect(reparsed.querySelector('[data-orei-canvas]')).toBeNull();
  expect(reparsed.querySelector('rect[fill="#b91c1c"]')).not.toBeNull();
  expect(reparsed.querySelector('text')?.textContent).toBe('Ordinary label');
});

test('png rasterization refuses an unoffered scale before any canvas work', async () => {
  await expect(png(opaqueSnapshot, 3)).rejects.toThrow(/scale/i);
  await expect(png(opaqueSnapshot, 0)).rejects.toThrow(/scale/i);
});

test('snapshots without a materialized background fall back to white', () => {
  const plain = snapshot(10, 10, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  const prepared: PreparedSvg = prepareSvg(plain, false);
  expect(prepared.background).toBe('#ffffff');
});
