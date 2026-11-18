import { describe, expect, it } from 'vitest';
import {
  decodePairedAssets,
  encodePairedAssets,
  imageReferences,
  pairedSnapshot,
} from '../src/paired-document';
import { parseImportedIconSvg } from '../src/icon-safety';

const icon = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
const envelope = (assets: unknown) => JSON.stringify({ format: 'orei-paired-assets', version: 1, assets });

describe('paired document assets', () => {
  it('round-trips custom icons and local images with their references unchanged', () => {
    const assets = { 'fixture:star': icon, 'assets/local.png': png };
    const text = encodePairedAssets(assets);
    expect(decodePairedAssets(text)).toEqual(assets);
    expect(text).toContain('"format": "orei-paired-assets"');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('shares the import flow\'s icon validation and limits', () => {
    const body = parseImportedIconSvg('custom:car', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="paint"><stop offset="0"/></linearGradient></defs><path fill="url(#paint)" d="M0 0h24v24H0z"/></svg>');
    expect(decodePairedAssets(encodePairedAssets({ 'custom:car': body }))['custom:car']).toBe(body);
    // Same rules on the paired read path as on import and render.
    expect(() => decodePairedAssets(envelope({ 'custom:bad': { kind: 'icon', mediaType: 'image/svg+xml', encoding: 'text', data: '<g><mask id="m"/></g><g><use href="https://example.test/x.svg"/></g>' } }))).toThrow();
  });

  it('round-trips an empty asset index', () => {
    expect(decodePairedAssets(encodePairedAssets({}))).toEqual({});
  });

  it('keeps an asset keyed like a prototype property through encode and decode', () => {
    const assets: Record<string, string> = { 'fixture:star': icon };
    Object.defineProperty(assets, '__proto__', { value: icon, enumerable: true, configurable: true, writable: true });
    const text = encodePairedAssets(assets);
    const decoded = decodePairedAssets(text);
    const own = Object.getOwnPropertyDescriptor(decoded, '__proto__');
    expect(own && own.value).toBe(icon);
    expect(JSON.parse(text).assets.__proto__.data).toBe(icon);
  });

  it.each([
    ['not JSON', '{'],
    ['wrong format', JSON.stringify({ format: 'orei', version: 1, assets: {} })],
    ['wrong version', JSON.stringify({ format: 'orei-paired-assets', version: 2, assets: {} })],
    ['missing assets', JSON.stringify({ format: 'orei-paired-assets', version: 1 })],
    ['array assets', envelope([])],
    ['non-object asset', envelope({ star: 'text' })],
  ])('rejects an invalid asset index: %s', (_label, text) => {
    expect(() => decodePairedAssets(text)).toThrow();
  });

  it('rejects unsafe icon definitions instead of accepting them silently', () => {
    expect(() => encodePairedAssets({ star: '<svg><script>alert(1)</script></svg>' })).toThrow();
    expect(() => encodePairedAssets({ star: '<svg><use href="https://example.test/icon.svg"/></svg>' })).toThrow();
    expect(() => encodePairedAssets({ star: '<svg><path onclick="alert(1)" d="M0 0"/></svg>' })).toThrow();
    expect(() => encodePairedAssets({ star: '' })).toThrow();
    expect(() => encodePairedAssets({ star: '<svg><path d="M0 0"/></svg>' })).not.toThrow();
  });

  it('rejects unsupported or oversized image data', () => {
    expect(() => encodePairedAssets({ 'a.png': 'data:image/svg+xml;base64,AAAA' })).toThrow();
    expect(() => encodePairedAssets({ 'a.png': 'https://example.test/a.png' })).toThrow();
    expect(() => encodePairedAssets({ 'a.png': 'data:image/png;base64,AAAA' + 'A'.repeat(2_000_000) })).toThrow();
  });

  it('rejects oversized icon text and too many assets', () => {
    expect(() => encodePairedAssets({ star: `<svg>${'x'.repeat(2 * 1024 * 1024)}</svg>` })).toThrow();
    const many = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`icon:${index}`, icon]));
    expect(() => encodePairedAssets(many)).toThrow('Too many');
  });

  it('rejects empty and oversized asset references', () => {
    expect(() => encodePairedAssets({ '': icon })).toThrow();
    expect(() => encodePairedAssets({ ['x'.repeat(513)]: icon })).toThrow();
    expect(() => decodePairedAssets(envelope({ '': { kind: 'icon', mediaType: 'image/svg+xml', encoding: 'text', data: icon } }))).toThrow();
  });

  it('rejects mismatched asset metadata', () => {
    expect(() => decodePairedAssets(envelope({ star: { kind: 'image', mediaType: 'image/svg+xml', encoding: 'text', data: icon } }))).toThrow();
    expect(() => decodePairedAssets(envelope({ 'a.png': { kind: 'image', mediaType: 'image/png', encoding: 'text', data: png } }))).toThrow();
  });
});

describe('paired document references', () => {
  it('finds deduplicated relative PNG image references in Mermaid source', () => {
    const source = [
      'flowchart LR',
      ' A@{ img: "assets/one.png" }',
      ' B@{ img: \'assets/two.png\' }',
      ' C@{ img: "assets/one.png" }',
      ' D@{ img: "data:image/png;base64,AAAA" }',
      ' E@{ img: "/absolute/three.png" }',
      ' F@{ img: "../outside/four.png" }',
      ' G@{ img: "https://example.test/five.png" }',
      ' H@{ img: "assets/six.svg" }',
      ' I@{ img: "assets\\\\seven.png" }',
    ].join('\n');
    expect(imageReferences(source)).toEqual(['assets/one.png', 'assets/two.png']);
  });

  it('ignores incomplete image references while editing', () => {
    expect(imageReferences('A@{ img: "unfinished')).toEqual([]);
    expect(imageReferences('A@{ img: 42 }')).toEqual([]);
  });
});

describe('paired save snapshot', () => {
  const document = { source: 'graph TD\n  A[Keep] --> B\n', css: '.pele { color: red; }\n', assets: {} };

  it('does not create a stylesheet companion for in-memory defaults', () => {
    expect(pairedSnapshot(document, { base: 'diagram', cssCompanion: false, assetsCompanion: false })).toEqual({
      source: document.source,
      css: null,
      assets: null,
    });
  });

  it('includes an existing or explicitly created stylesheet companion verbatim', () => {
    expect(pairedSnapshot(document, { base: 'diagram', cssCompanion: true, assetsCompanion: false }).css).toBe(document.css);
  });

  it('writes an asset index when assets were loaded or a companion already exists', () => {
    const withAssets = { ...document, assets: { 'fixture:star': icon } };
    expect(JSON.parse(pairedSnapshot(withAssets, { base: 'diagram', cssCompanion: false, assetsCompanion: false }).assets!).assets)
      .toEqual({ 'fixture:star': { kind: 'icon', mediaType: 'image/svg+xml', encoding: 'text', data: icon } });
    expect(JSON.parse(pairedSnapshot(document, { base: 'diagram', cssCompanion: false, assetsCompanion: true }).assets!).assets)
      .toEqual({});
  });

  it('preserves comments and whitespace exactly because text is never rewritten', () => {
    const source = '%% leading comment\nflowchart LR\n\n   A[  spaced  ] --> B %% trailing\n';
    const css = '/* authored */\n.node {\n  color : red ; /* keep */\n}\n\n';
    const snapshot = pairedSnapshot({ source, css, assets: {} }, { base: 'diagram', cssCompanion: true, assetsCompanion: false });
    expect(snapshot.source).toBe(source);
    expect(snapshot.css).toBe(css);
  });
});
