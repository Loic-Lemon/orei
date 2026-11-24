import { describe, expect, test } from 'vitest';
import { renderDiagram } from '../src/rendering';
import { imageSnippet } from '../src/image-import';
import { applyImageStyle, type ImageStyle } from '../src/image-styling';

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

function parse(svg: string): SVGSVGElement {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  expect(parsed.querySelector('parsererror')).toBeNull();
  return parsed.documentElement as unknown as SVGSVGElement;
}

function styledCss(reference: string, style: ImageStyle): string {
  const result = applyImageStyle('', reference, style);
  if ('problem' in result) throw new Error(result.problem);
  return result.css;
}

const attribute = (element: Element, name: string) => Number(element.getAttribute(name));
const clipFor = (svg: SVGSVGElement, image: Element) => {
  const id = /^url\(#(.+)\)$/.exec(image.getAttribute('clip-path') ?? '')?.[1];
  expect(id).toBeTruthy();
  const clip = [...svg.querySelectorAll('clipPath')].find(candidate => candidate.getAttribute('id') === id);
  expect(clip).toBeDefined();
  return { id: id!, clip: clip!, rect: clip!.querySelector('rect')! };
};

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

  test('a carried PNG remains self-contained and keeps its aspect ratio after resizing', async () => {
    const data = png(480, 240);
    const snippet = imageSnippet('assets/photo.png', data).replace('w: 240', 'w: 160');
    const result = await renderDiagram({ source: `flowchart LR\n A${snippet}`, css: '', assets: { 'assets/photo.png': data } }, settings);
    const svg = new DOMParser().parseFromString(result.svg, 'image/svg+xml');
    const image = svg.querySelector('image');
    expect(image?.getAttribute('href')).toBe(data);
    expect(image?.getAttribute('width')).toBe('160');
    expect(image?.getAttribute('height')).toBe('120');
    expect(image?.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    expect(result.svg).not.toContain('assets/photo.png');
    // Unstyled images keep the existing output path: no clip or border scaffolding.
    expect(svg.querySelector('clipPath')).toBeNull();
    expect(svg.querySelector('[data-orei-image-border]')).toBeNull();
    expect(svg.querySelector('image')?.hasAttribute('clip-path')).toBe(false);
  });
});

describe('styled local images in the standalone snapshot', () => {
  test('clips the painted PNG bounds of an uneven aspect ratio and insets the border', async () => {
    const data = png(480, 240);
    const css = styledCss('assets/photo.png', { radius: 12, borderWidth: 4, borderColor: '#235d56' });
    const result = await renderDiagram({
      source: 'flowchart LR\n A@{ img: "assets/photo.png", w: 160, h: 160, constraint: "on", label: "Photo" }',
      css,
      assets: { 'assets/photo.png': data },
    }, settings);
    const svg = parse(result.svg);
    const image = svg.querySelector('image')!;
    expect(image.getAttribute('href')).toBe(data);
    expect(image.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    // Node geometry is untouched; the PNG is letterboxed inside the 160 x 160 node.
    expect([attribute(image, 'x'), attribute(image, 'y'), attribute(image, 'width'), attribute(image, 'height')]).toEqual([-80, -95, 160, 160]);

    const { id, rect } = clipFor(svg, image);
    expect([attribute(rect, 'x'), attribute(rect, 'y'), attribute(rect, 'width'), attribute(rect, 'height')]).toEqual([-80, -55, 160, 80]);
    expect(attribute(rect, 'rx')).toBe(12);
    expect((image as SVGElement).style.getPropertyValue('clip-path')).toMatch(new RegExp(`^url\\(["']?#${id}["']?\\)$`));
    // The clip lives in the same translated node group as the image.
    expect(rect.closest('clipPath')!.parentElement).toBe(image.parentElement);

    const border = svg.querySelector('[data-orei-image-border]')!;
    expect(border.tagName).toBe('rect');
    expect(border.getAttribute('clip-path')).toBe(image.getAttribute('clip-path'));
    expect([attribute(border, 'x'), attribute(border, 'y'), attribute(border, 'width'), attribute(border, 'height')]).toEqual([-78, -53, 156, 76]);
    expect(attribute(border, 'rx')).toBe(10);
    expect(border.getAttribute('fill')).toBe('none');
    expect(border.getAttribute('stroke')).toBe('#235d56');
    expect(attribute(border, 'stroke-width')).toBe(4);
    expect(border.previousElementSibling).toBe(image);
    // Connectors, labels and layout dimensions survive the decoration.
    expect([...svg.querySelectorAll('text')].map(element => element.textContent)).toContain('Photo');
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${result.width} ${result.height}`);
  });

  test('uses the full node box when Pele stretches an image without a constraint', async () => {
    const data = png(480, 240);
    const css = styledCss('assets/photo.png', { radius: 8, borderWidth: 0, borderColor: '#235d56' });
    const result = await renderDiagram({
      source: 'flowchart LR\n A@{ img: "assets/photo.png", w: 160, h: 160 }',
      css,
      assets: { 'assets/photo.png': data },
    }, settings);
    const svg = parse(result.svg);
    const image = svg.querySelector('image')!;
    expect(image.getAttribute('preserveAspectRatio')).toBe('none');
    const { rect } = clipFor(svg, image);
    expect([attribute(rect, 'x'), attribute(rect, 'y'), attribute(rect, 'width'), attribute(rect, 'height')]).toEqual([-80, -80, 160, 160]);
    expect(svg.querySelector('[data-orei-image-border]')).toBeNull();
  });

  test('inline decoration wins over a retained broad stylesheet rule', async () => {
    const data = png(480, 240);
    const css = `${styledCss('assets/photo.png', { radius: 8, borderWidth: 2, borderColor: '#235d56' })}\n.pele rect { fill: #ff0000; stroke: #00ff00; stroke-width: 9px; }\n`;
    const result = await renderDiagram({
      source: 'flowchart LR\n A@{ img: "assets/photo.png", w: 160, h: 160, constraint: "on" }',
      css,
      assets: { 'assets/photo.png': data },
    }, settings);
    const svg = parse(result.svg);
    const image = svg.querySelector('image')!;
    const border = svg.querySelector('[data-orei-image-border]') as SVGElement;
    const style = border.getAttribute('style')!;
    expect(style).toContain('fill: none');
    expect(style).toMatch(/stroke:\s*(?:#235d56|rgb\(35,\s*93,\s*86\))/);
    expect(style).toContain('stroke-width: 2');
    expect((image as SVGElement).style.getPropertyValue('clip-path')).toMatch(/^url\(["']?#orei-image-clip/);
  });

  test('uses the actual painted bounds at each size for repeated references and gives every clip a unique id', async () => {
    const data = png(480, 240);
    const css = styledCss('assets/photo.png', { radius: 6, borderWidth: 2, borderColor: '#0284c7' });
    const result = await renderDiagram({
      source: 'flowchart LR\n A@{ img: "assets/photo.png", w: 160, h: 160, constraint: "on" }\n B@{ img: "assets/photo.png", w: 400, h: 100, constraint: "on" }',
      css,
      assets: { 'assets/photo.png': data },
    }, settings);
    const svg = parse(result.svg);
    const images = [...svg.querySelectorAll('image')];
    expect(images).toHaveLength(2);
    const first = clipFor(svg, images[0]);
    const second = clipFor(svg, images[1]);
    expect(first.id).not.toBe(second.id);
    expect([attribute(first.rect, 'x'), attribute(first.rect, 'y'), attribute(first.rect, 'width'), attribute(first.rect, 'height')]).toEqual([-80, -40, 160, 80]);
    expect([attribute(second.rect, 'x'), attribute(second.rect, 'y'), attribute(second.rect, 'width'), attribute(second.rect, 'height')]).toEqual([-100, -50, 200, 100]);
    expect(svg.querySelectorAll('clipPath')).toHaveLength(2);
    const ids = [...svg.querySelectorAll('[id]')].map(element => element.getAttribute('id')!);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('keeps each image reference independent and clamps radius and border for small images', async () => {
    const wide = png(480, 240);
    const small = png(6, 4);
    const withWide = styledCss('assets/wide.png', { radius: 6, borderWidth: 2, borderColor: '#235d56' });
    const result = applyImageStyle(withWide, 'assets/small.png', { radius: 50, borderWidth: 20, borderColor: '#c2410c' });
    if ('problem' in result) throw new Error(result.problem);
    const css = result.css;
    const rendered = await renderDiagram({
      source: 'flowchart LR\n A@{ img: "assets/wide.png", w: 160, h: 160, constraint: "on" }\n B@{ img: "assets/small.png", w: 6, h: 4, constraint: "on" }',
      css,
      assets: { 'assets/wide.png': wide, 'assets/small.png': small },
    }, settings);
    const svg = parse(rendered.svg);
    const [first, second] = [...svg.querySelectorAll('image')];
    const firstClip = clipFor(svg, first);
    const secondClip = clipFor(svg, second);
    expect(attribute(firstClip.rect, 'rx')).toBe(6);
    // Painted 6 x 4: radius stops at half the shorter side, border at the shorter side.
    expect(attribute(secondClip.rect, 'rx')).toBe(2);
    const secondBorder = second.nextElementSibling as Element;
    expect(secondBorder.getAttribute('stroke')).toBe('#c2410c');
    // Requested 20 px on a 6 x 4 image is clamped to half the shorter side, keeping a
    // real interior (a zero-height rect would not paint at all).
    expect(attribute(secondBorder, 'stroke-width')).toBe(2);
    expect([attribute(secondBorder, 'x'), attribute(secondBorder, 'y'), attribute(secondBorder, 'width'), attribute(secondBorder, 'height')]).toEqual([-2, -1, 4, 2]);
    expect(attribute(secondBorder, 'rx')).toBe(1);
    // The stroke's outer edge stays on the painted bounds.
    const left = attribute(secondBorder, 'x') - attribute(secondBorder, 'stroke-width') / 2;
    const top = attribute(secondBorder, 'y') - attribute(secondBorder, 'stroke-width') / 2;
    expect(left).toBe(attribute(secondClip.rect, 'x'));
    expect(top).toBe(attribute(secondClip.rect, 'y'));
    const borderCount = svg.querySelectorAll('[data-orei-image-border]').length;
    expect(borderCount).toBe(2);
  });

  test('malformed or duplicate styling metadata leaves every image using the current defaults', async () => {
    const data = png(480, 240);
    for (const css of [
      '/* orei:image-styles:v1 {"images": */',
      '/* orei:image-styles:v1 {"images":{"assets%2Fphoto.png":{"radius":1,"borderWidth":1,"borderColor":"url(https://example.test/x)"}}} */',
      '/* orei:image-styles:v1 url(https://example.test/x)',
      '/* orei:image-styles:v1 {"images":{}} */\n/* orei:image-styles:v1 {"images":{}} */',
      '/* orei:image-styles:v9 {"images":{"assets%2Fphoto.png":{"radius":8,"borderWidth":2,"borderColor":"#235d56"}}} */',
    ]) {
      const result = await renderDiagram({ source: 'flowchart LR\n A@{ img: "assets/photo.png", w: 160, h: 160, constraint: "on" }', css, assets: { 'assets/photo.png': data } }, settings);
      const svg = parse(result.svg);
      expect(svg.querySelector('image')?.getAttribute('href')).toBe(data);
      expect(svg.querySelector('clipPath')).toBeNull();
      expect(svg.querySelector('[data-orei-image-border]')).toBeNull();
      expect(result.svg).not.toContain('example.test');
    }
    await expect(renderDiagram({ source: 'flowchart LR\n A --> B', css: '/* orei:image-styles:v1 {} */\n.pele { fill: url(https://example.test/x); }', assets: {} }, settings))
      .rejects.toThrow('Offline stylesheet');
  });

  test('a style keyed by an unusual but supported PNG path matches the reference exactly', async () => {
    const reference = 'assets/my photo (1)*#.png';
    const data = png(40, 20);
    const css = styledCss(reference, { radius: 5, borderWidth: 1, borderColor: '#235d56' });
    const result = await renderDiagram({
      source: `flowchart LR\n A@{ img: ${JSON.stringify(reference)}, w: 40, h: 40, constraint: "on" }`,
      css,
      assets: { [reference]: data },
    }, settings);
    const svg = parse(result.svg);
    const image = svg.querySelector('image')!;
    const { rect } = clipFor(svg, image);
    expect([attribute(rect, 'x'), attribute(rect, 'y'), attribute(rect, 'width'), attribute(rect, 'height')]).toEqual([-20, -10, 40, 20]);
    expect(attribute(rect, 'rx')).toBe(5);
    expect(result.svg).not.toContain(reference);
    expect(css).not.toContain(reference);
  });
});
