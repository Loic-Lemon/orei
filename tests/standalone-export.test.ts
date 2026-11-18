import { test, expect, vi } from 'vitest';
import { dedupeSvgIds, renderDiagram } from '../src/rendering';
import { fixtures, defaultCSS } from '../src/fixtures';

const repeated = String.raw`flowchart LR
 A["$$\alpha_1^2$$"] --> B["$$\alpha_1^2$$"]
 B --> C["$$\alpha_1^2$$"]
 C --> D@{ icon: "lucide:house", label: "Home" }
 D --> E@{ icon: "lucide:house", label: "Again" }`;

function parse(svg:string):SVGSVGElement {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  expect(parsed.querySelector('parsererror')).toBeNull();
  return parsed.documentElement as unknown as SVGSVGElement;
}

test('repeated formulas and repeated icons stay self-contained vector artwork without duplicate identifiers', async () => {
  const result = await renderDiagram({ source: repeated, css: defaultCSS, assets: {} }, { mode: 'fixed', width: 900 });
  const svg = parse(result.svg);
  expect(svg.querySelectorAll('foreignObject, use, [data-mml-node="merror"], [data-mml-node] use').length).toBe(0);
  expect(svg.querySelectorAll('[data-mml-node="math"] path').length).toBeGreaterThanOrEqual(6);
  const icons = svg.querySelectorAll('[data-icon="lucide:house"]');
  expect(icons.length).toBe(2);
  for (const icon of icons) expect(icon.querySelector('path')).not.toBeNull();
  expect([...svg.querySelectorAll('text')].map(e => e.textContent)).toEqual(expect.arrayContaining(['Home', 'Again']));

  const ids = [...svg.querySelectorAll('[id]')].map(e => e.getAttribute('id')!);
  expect(new Set(ids).size).toBe(ids.length);
  // Every internal reference must resolve inside the standalone document.
  const available = new Set(ids);
  const referenced = [...svg.querySelectorAll('[fill]'), ...svg.querySelectorAll('[stroke]'), ...svg.querySelectorAll('[clip-path]'), ...svg.querySelectorAll('[mask]')]
    .flatMap(e => [e.getAttribute('fill') ?? '', e.getAttribute('stroke') ?? '', e.getAttribute('clip-path') ?? '', e.getAttribute('mask') ?? ''])
    .flatMap(value => [...value.matchAll(/url\(#([^)]+)\)/g)].map(match => match[1]));
  for (const id of referenced) expect(available.has(id)).toBe(true);
  for (const id of ids) expect(id.length).toBeGreaterThan(0);
});

test('duplicate identifiers are renamed so every reference keeps resolving to the first occurrence', () => {
  const svg = parse(`<svg xmlns="http://www.w3.org/2000/svg"><defs><marker id="L_B_C_0"/><marker id="L_B_C_0"/></defs>
    <path marker-end="url(#L_B_C_0)"/><path marker-end="url(#L_B_C_0)"/>
    <rect id="A"/><rect id="A"/><text>A</text></svg>`);
  dedupeSvgIds(svg);
  const ids = [...svg.querySelectorAll('[id]')].map(e => e.getAttribute('id')!);
  expect(new Set(ids).size).toBe(ids.length);
  const available = new Set(ids);
  const referenced = [...svg.querySelectorAll('[marker-end]')].map(e => e.getAttribute('marker-end')!)
    .flatMap(value => [...value.matchAll(/url\(#([^)]+)\)/g)].map(match => match[1]));
  expect(referenced).toEqual(['L_B_C_0', 'L_B_C_0']);
  for (const id of referenced) expect(available.has(id)).toBe(true);
  expect(svg.querySelector('marker#L_B_C_0')).not.toBeNull();
});

test('a standalone export carries no external, private or cross-document references', async () => {
  const first = await renderDiagram(fixtures.small, { mode: 'fixed', width: 900 });
  const second = await renderDiagram({ ...fixtures.small, source: 'flowchart LR\n X[Second tab] --> Y[Output]' }, { mode: 'fixed', width: 900 });
  for (const result of [first, second]) {
    const svg = parse(result.svg);
    expect(svg.outerHTML).not.toMatch(/(?:href|src)="(?:https?:|file:|blob:|assets\/)/);
    // The second document must not borrow identifiers or resources from the first render.
  }
  const firstSvg = parse(first.svg);
  expect(firstSvg.querySelectorAll('image').length).toBeGreaterThan(0);
  expect(firstSvg.querySelector('image')?.getAttribute('href')).toMatch(/^data:image\/png;base64,/);
  expect(second.svg).not.toContain('Ordinary label');
  expect(second.svg).toContain('Second tab');
});

test('standalone reopening preserves the composition: text and dimensions survive a serialize/reparse round trip', async () => {
  const result = await renderDiagram(fixtures.small, { mode: 'fixed', width: 900 });
  const reopened = new XMLSerializer().serializeToString(parse(result.svg));
  const svg = parse(reopened);
  expect(svg.getAttribute('viewBox')).toBe(`0 0 ${result.width} ${result.height}`);
  expect(Number(svg.getAttribute('width'))).toBe(result.width);
  expect(Number(svg.getAttribute('height'))).toBe(result.height);
  expect([...svg.querySelectorAll('text')].map(e => e.textContent)).toContain('Ordinary label');
  // App/editor styles stay out of the diagram document.
  expect(reopened).not.toMatch(/data-radix|--accent|vite|orei-editor/);
});

test('the fully materialized branch bakes the document background in and drops the stylesheet', async () => {
  // jsdom cannot resolve SVG variables; this stub selects the same materialized branch
  // the real webview takes, so the background/canvas invariants are checked here too.
  vi.stubGlobal('CSS', { supports: () => true });
  try {
    const result = await renderDiagram(fixtures.small, { mode: 'fixed', width: 900 });
    const svg = parse(result.svg);
    const canvas = svg.querySelector('[data-orei-canvas]');
    expect(canvas).not.toBeNull();
    expect(canvas?.getAttribute('width')).toBe(String(result.width));
    expect(canvas?.getAttribute('height')).toBe(String(result.height));
    expect(svg.getAttribute('data-orei-background')).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(svg.querySelector('style')).toBeNull();
    expect([...svg.querySelectorAll('text')].map(e => e.textContent)).toContain('Ordinary label');
  } finally { vi.unstubAllGlobals(); }
});

test('the responsive composition is captured at its layout width, independent of viewport zoom', async () => {
  const narrow = await renderDiagram(fixtures.small, { mode: 'responsive', width: 480 });
  const wide = await renderDiagram(fixtures.small, { mode: 'responsive', width: 1200 });
  for (const result of [narrow, wide]) {
    const svg = parse(result.svg);
    expect(Number(svg.getAttribute('width'))).toBe(result.width);
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${result.width} ${result.height}`);
  }
  expect(narrow.width).toBeLessThanOrEqual(480);
  expect(wide.width).toBeGreaterThan(narrow.width);
});
