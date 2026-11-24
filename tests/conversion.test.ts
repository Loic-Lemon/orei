import { expect, test } from 'vitest';
import { defaultDestinationName, documentFormat, planConversion } from '../src/conversion';
import { createMarkdownDocument, updateMarkdownDocument } from '../src/markdown-document';

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

test('Markdown to Markdown plans the format only once the existing envelope validates', () => {
  const envelope = createMarkdownDocument({ mermaid: 'old mermaid\n', css: '.old { color: blue; }\n' });
  const document = markdownDocument({ originalMarkdown: `# Note\n\nKeep this paragraph.\n\n${envelope}\nTail text.\n` });
  expect(planConversion(document, 'markdown')).toEqual({ format: 'markdown' });
});

test('updating a note preserves surrounding Markdown and replaces only the Mermaid and CSS blocks', () => {
  const envelope = createMarkdownDocument({ mermaid: 'old mermaid\n', css: '.old { color: blue; }\n' });
  const document = markdownDocument({ originalMarkdown: `# Note\n\nKeep this paragraph.\n\n${envelope}\nTail text.\n` });
  const text = updateMarkdownDocument(document.originalMarkdown, { mermaid: document.source, css: document.css });
  expect(text).toContain('Keep this paragraph.');
  expect(text).toContain('Tail text.');
  expect(text).toContain('flowchart LR\n  A --> B\n');
  expect(text).toContain('.node { color: red; }');
  expect(text).not.toContain('.old { color: blue; }');
});

test('Markdown composition builds a new note when there is no existing envelope', () => {
  const document = pairedDocument();
  expect(planConversion(document, 'markdown')).toEqual({ format: 'markdown' });
  const text = createMarkdownDocument({ mermaid: document.source, css: document.css });
  expect(text).toContain('```mermaid\nflowchart LR\n  A --> B\n```');
  expect(text).toContain('<!-- orei:css:start -->');
  expect(text).toContain('```css\n.node { color: red; }\n```');
});

test('Markdown composition keeps image and icon references for the attachments folder', () => {
  const document = pairedDocument({
    source: 'flowchart LR\n  A@{ icon: "fixture:star" }\n  B@{ img: "assets/local.png" }\n',
    assets: { 'fixture:star': icon, 'assets/local.png': image },
  });
  expect(planConversion(document, 'markdown')).toEqual({ format: 'markdown' });
  const text = createMarkdownDocument({ mermaid: document.source, css: document.css });
  expect(text).toContain('@{ icon: "fixture:star" }');
  expect(text).toContain('@{ img: "assets/local.png" }');
});

test('Markdown composition preserves unresolved local image reference text', () => {
  const document = pairedDocument({ source: 'flowchart LR\n  A@{ img: "assets/missing.png" }\n' });
  // Composition never resolves assets, so a missing body passes through inside the fence;
  // only the paired destination rejects it.
  expect(planConversion(document, 'markdown')).toEqual({ format: 'markdown' });
  expect(createMarkdownDocument({ mermaid: document.source, css: document.css })).toContain('@{ img: "assets/missing.png" }');
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

test('Markdown composition preserves an image reference because the note itself carries it', () => {
  const document = markdownDocument({ source: 'flowchart LR\n  A@{ img: "assets/local.png" }\n' });
  expect(planConversion(document, 'markdown')).toEqual({ format: 'markdown' });
  const text = updateMarkdownDocument(document.originalMarkdown, { mermaid: document.source, css: document.css });
  expect(text).toContain('assets/local.png');
});

test('a malformed Markdown envelope fails planning before a destination exists', () => {
  expect(() => planConversion(markdownDocument({ originalMarkdown: 'no fences here' }), 'markdown'))
    .toThrow(/Missing, duplicate, or malformed CSS markers/);
});

test('format detection and default destination names follow the document, not a stored preference', () => {
  expect(documentFormat(markdownDocument())).toBe('markdown');
  expect(documentFormat(pairedDocument())).toBe('paired');
  expect(defaultDestinationName(markdownDocument(), 'note.md', 'paired')).toBe('note.mmd');
  expect(defaultDestinationName(pairedDocument(), 'diagram.mmd', 'markdown')).toBe('diagram.md');
  expect(defaultDestinationName({ source: '', css: '', assets: {} }, 'Untitled 2', 'markdown')).toBe('Untitled 2.md');
});
