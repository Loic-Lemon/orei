import { expect, test } from 'vitest';
import { defaultDestinationName, documentFormat, planConversion, sameConversion } from '../src/conversion';
import { createMarkdownDocument } from '../src/markdown-document';

const icon = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>';
const image = 'data:image/png;base64,iVBORw0KGgo=';

const markdownDocument = (overrides: Record<string, unknown> = {}) => ({
  source: 'flowchart LR\n  A --> B\n',
  css: '.node { color: red; }\n',
  assets: {},
  originalMarkdown: createMarkdownDocument({ mermaid: 'flowchart LR\n  A --> B\n', css: '.node { color: red; }\n' }),
  ...overrides,
});

const pairedDocument = (overrides: Record<string, unknown> = {}) => ({
  source: 'flowchart LR\n  A --> B\n',
  css: '.node { color: red; }\n',
  assets: {},
  pair: { base: 'diagram', cssCompanion: true, assetsCompanion: false },
  ...overrides,
});

test('Markdown to paired keeps source and stylesheet text byte-for-byte and adds a stylesheet companion', () => {
  const document = markdownDocument();
  const conversion = planConversion(document, 'paired');
  expect(conversion).toEqual({
    format: 'paired',
    snapshot: { source: document.source, css: document.css, assets: null },
  });
});

test('Markdown to paired carries every icon name and image data URL into the adjacent asset index', () => {
  const conversion = planConversion(markdownDocument({
    source: 'flowchart LR\n  A@{ icon: "fixture:star" }\n  B@{ img: "assets/local.png" }\n',
    assets: { 'fixture:star': icon, 'assets/local.png': image },
  }), 'paired');
  expect(conversion.format).toBe('paired');
  if (conversion.format !== 'paired') throw new Error('expected paired');
  const index = JSON.parse(conversion.snapshot.assets!);
  expect(index.assets['fixture:star']).toEqual({ kind: 'icon', mediaType: 'image/svg+xml', encoding: 'text', data: icon });
  expect(index.assets['assets/local.png']).toEqual({ kind: 'image', mediaType: 'image/png', encoding: 'data-url', data: image });
});

test('paired to Markdown preserves surrounding Markdown when the source already is a note', () => {
  const envelope = createMarkdownDocument({ mermaid: 'old mermaid\n', css: '.old { color: blue; }\n' });
  const document = markdownDocument({
    originalMarkdown: `# Note\n\nKeep this paragraph.\n\n${envelope}\nTail text.\n`,
  });
  const conversion = planConversion(document, 'markdown');
  expect(conversion.format).toBe('markdown');
  if (conversion.format !== 'markdown') throw new Error('expected markdown');
  expect(conversion.text).toContain('Keep this paragraph.');
  expect(conversion.text).toContain('Tail text.');
  expect(conversion.text).toContain('flowchart LR\n  A --> B\n');
  expect(conversion.text).toContain('.node { color: red; }');
  expect(conversion.text).not.toContain('.old { color: blue; }');
});

test('paired to Markdown builds a new note when there is no existing Markdown envelope', () => {
  const conversion = planConversion(pairedDocument(), 'markdown');
  expect(conversion.format).toBe('markdown');
  if (conversion.format !== 'markdown') throw new Error('expected markdown');
  expect(conversion.text).toContain('```mermaid\nflowchart LR\n  A --> B\n```');
  expect(conversion.text).toContain('<!-- orei:css:start -->');
  expect(conversion.text).toContain('```css\n.node { color: red; }\n```');
});

test('paired to Markdown refuses documents with icon definitions or embedded images through the shared gate', () => {
  expect(() => planConversion(pairedDocument({
    source: 'flowchart LR\n  A@{ icon: "fixture:star" }\n',
    assets: { 'fixture:star': icon },
  }), 'markdown')).toThrow(/Markdown asset storage is not specified yet.*fixture:star/);
  expect(() => planConversion(pairedDocument({
    source: 'flowchart LR\n  A@{ icon: "fixture:star" }\n',
    assets: { 'fixture:star': icon },
  }), 'markdown')).toThrow(/remain in this draft's local recovery/);

  expect(() => planConversion(pairedDocument({
    source: 'flowchart LR\n  A@{ img: "assets/local.png" }\n',
    assets: { 'assets/local.png': image },
  }), 'markdown')).toThrow(/1 embedded asset \(assets\/local\.png\)/);
});

test('paired to Markdown refuses unresolved local image references kept as source text', () => {
  expect(() => planConversion(pairedDocument({
    source: 'flowchart LR\n  A@{ img: "assets/missing.png" }\n',
  }), 'markdown')).toThrow(/local image reference assets\/missing\.png cannot be resolved/);
});

test('paired to paired refuses references whose image content is not embedded', () => {
  expect(() => planConversion(pairedDocument({
    source: 'flowchart LR\n  A@{ img: "assets/missing.png" }\n',
  }), 'paired')).toThrow(/assets\/missing\.png has no embedded content/);
});

test('Markdown to paired refuses a reference without embedded image content', () => {
  expect(() => planConversion(markdownDocument({
    source: 'flowchart LR\n  A@{ img: "assets/missing.png" }\n',
  }), 'paired')).toThrow(/assets\/missing\.png has no embedded content/);
});

test('paired to paired refuses an image reference backed by a non-image asset body', () => {
  expect(() => planConversion(pairedDocument({
    source: 'flowchart LR\n  A@{ img: "assets/local.png" }\n',
    assets: { 'assets/local.png': icon },
  }), 'paired')).toThrow(/assets\/local\.png has no embedded content/);
});

test('paired to paired preserves the index when every reference is embedded and keeps an empty companion', () => {
  const withAssets = planConversion(pairedDocument({
    source: 'flowchart LR\n  A@{ img: "assets/local.png" }\n',
    assets: { 'assets/local.png': image },
    pair: { base: 'diagram', cssCompanion: true, assetsCompanion: true },
  }), 'paired');
  expect(withAssets.format).toBe('paired');
  if (withAssets.format !== 'paired') throw new Error('expected paired');
  expect(JSON.parse(withAssets.snapshot.assets!).assets['assets/local.png'].data).toBe(image);

  const emptyCompanion = planConversion(pairedDocument({
    pair: { base: 'diagram', cssCompanion: true, assetsCompanion: true },
  }), 'paired');
  expect(emptyCompanion.format).toBe('paired');
  if (emptyCompanion.format !== 'paired') throw new Error('expected paired');
  expect(JSON.parse(emptyCompanion.snapshot.assets!)).toEqual({ format: 'orei-paired-assets', version: 1, assets: {} });
});

test('Markdown to Markdown preserves an image reference because the representation already carries it', () => {
  const document = markdownDocument({ source: 'flowchart LR\n  A@{ img: "assets/local.png" }\n' });
  const conversion = planConversion(document, 'markdown');
  expect(conversion.format).toBe('markdown');
  if (conversion.format !== 'markdown') throw new Error('expected markdown');
  expect(conversion.text).toContain('assets/local.png');
});

test('a malformed Markdown envelope fails conversion without producing a destination', () => {
  expect(() => planConversion(markdownDocument({ originalMarkdown: 'no fences here' }), 'markdown')).toThrow();
});

test('conversion comparison distinguishes content changes', () => {
  const document = markdownDocument();
  const planned = planConversion(document, 'paired');
  expect(sameConversion(planned, planConversion(document, 'paired'))).toBe(true);
  expect(sameConversion(planned, planConversion({ ...document, source: 'graph TD\n' }, 'paired'))).toBe(false);
  expect(sameConversion(planned, planConversion(document, 'markdown'))).toBe(false);
});

test('format detection and default destination names follow the document, not a stored preference', () => {
  expect(documentFormat(markdownDocument())).toBe('markdown');
  expect(documentFormat(pairedDocument())).toBe('paired');
  expect(defaultDestinationName(markdownDocument(), 'note.md', 'paired')).toBe('note.mmd');
  expect(defaultDestinationName(pairedDocument(), 'diagram.mmd', 'markdown')).toBe('diagram.md');
  expect(defaultDestinationName({ source: '', css: '', assets: {} }, 'Untitled 2', 'markdown')).toBe('Untitled 2.md');
});
