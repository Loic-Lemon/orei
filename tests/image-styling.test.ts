import { describe, expect, test } from 'vitest';
import { createMarkdownDocument, parseMarkdownDocument, updateMarkdownDocument } from '../src/markdown-document';
import { pairedSnapshot } from '../src/paired-document';
import { planConversion } from '../src/conversion';
import {
  DEFAULT_IMAGE_BORDER_COLOR,
  MAX_STYLESHEET_TEXT,
  applyImageStyle,
  decodeImageStyleKey,
  defaultImageStyle,
  encodeImageStyleKey,
  imageStyleControlLabel,
  imageStyleFor,
  imageStyleProblem,
  isDefaultImageStyle,
  normalizeImageStyle,
  readImageStyles,
  type ImageStyle,
} from '../src/image-styling';

const style: ImageStyle = { radius: 8, borderWidth: 2, borderColor: '#235d56' };
const reference = 'assets/photo.png';
const base = '/* palette */\n.pele {\n  --pele-border: #0284c7;\n}\n.node { fill: red; }\n';

function styled(css: string, target: string, values: unknown): string {
  const result = applyImageStyle(css, target, values);
  if ('problem' in result) throw new Error(result.problem);
  return result.css;
}

function blockCount(css: string): number {
  return [...css.matchAll(/\/\*\s*orei:image-styles:/g)].length;
}

describe('managed image styling comment', () => {
  test('a missing comment means default styling', () => {
    expect(readImageStyles(base)).toEqual({ styles: new Map() });
    expect(imageStyleFor(base, reference)).toMatchObject({ present: false, style: defaultImageStyle(base), problem: undefined });
    expect(imageStyleProblem(base)).toBeUndefined();
  });

  test('writes one versioned comment and reads the same values back', () => {
    const css = styled(base, reference, style);
    expect(css.startsWith(base)).toBe(true);
    expect(blockCount(css)).toBe(1);
    expect(css).toContain('orei:image-styles:v1');
    expect(readImageStyles(css).styles.get(reference)).toEqual(style);
    expect(imageStyleFor(css, reference)).toMatchObject({ present: true, style, problem: undefined });
  });

  test('merges another reference into the same single comment and preserves unrelated CSS', () => {
    const first = styled(base, reference, style);
    const second = styled(first, 'pasted-image.png', { radius: 0, borderWidth: 4, borderColor: 'red' });
    expect(blockCount(second)).toBe(1);
    expect(second.startsWith(base)).toBe(true);
    expect(readImageStyles(second).styles.get(reference)).toEqual(style);
    expect(readImageStyles(second).styles.get('pasted-image.png')).toEqual({ radius: 0, borderWidth: 4, borderColor: 'red' });
  });

  test('updates only the managed comment and leaves the prefix and suffix untouched', () => {
    const prefix = '/* before */\n.a { color: blue; }\n';
    const suffix = '\n/* after */\n.b { color: green; }\n';
    const css = styled(prefix, reference, style) + suffix;
    const updated = styled(css, reference, { radius: 20, borderWidth: 0, borderColor: '#000000' });
    expect(updated.startsWith(prefix)).toBe(true);
    expect(updated.endsWith(suffix)).toBe(true);
    expect(updated).not.toContain('"radius":8');
    expect(readImageStyles(updated).styles.get(reference)).toEqual({ radius: 20, borderWidth: 0, borderColor: '#000000' });
  });

  test('Reset removes the entry, then the comment, restoring the original stylesheet', () => {
    const withStyle = styled(base, reference, style);
    const reset = styled(withStyle, reference, defaultImageStyle(base));
    expect(reset).toBe(base);
    expect(blockCount(reset)).toBe(0);
    expect(imageStyleFor(reset, reference).style).toEqual(defaultImageStyle(base));
  });

  test('applying defaults when nothing is stored changes nothing', () => {
    const result = applyImageStyle(base, reference, defaultImageStyle(base));
    expect(result).toEqual({ css: base, changed: false });
  });

  test('different images keep independent values', () => {
    const first = styled(styled('', reference, style), 'other.png', { radius: 1, borderWidth: 1, borderColor: '#fff' });
    const resetFirst = styled(first, reference, defaultImageStyle(''));
    expect(readImageStyles(resetFirst).styles.has(reference)).toBe(false);
    expect(readImageStyles(resetFirst).styles.get('other.png')).toEqual({ radius: 1, borderWidth: 1, borderColor: '#fff' });
  });

  test('malformed, duplicate and unsupported metadata is reported and never overwritten', () => {
    const malformed = `${base}/* orei:image-styles:v1 {"images": */\n`;
    expect(imageStyleProblem(malformed)).toMatch(/malformed/);
    expect(readImageStyles(malformed).styles.size).toBe(0);
    expect(applyImageStyle(malformed, reference, style)).toEqual({ problem: imageStyleProblem(malformed) });

    const duplicate = `${styled(base, reference, style)}\n${'/* orei:image-styles:v1 {"images":{}} */'}\n`;
    expect(imageStyleProblem(duplicate)).toMatch(/more than one/);
    expect(applyImageStyle(duplicate, reference, style)).toEqual({ problem: imageStyleProblem(duplicate) });

    const unsupported = `${base}/* orei:image-styles:v2 {"images":{}} */\n`;
    expect(imageStyleProblem(unsupported)).toMatch(/unsupported version v2/);
    expect(applyImageStyle(unsupported, reference, style)).toEqual({ problem: imageStyleProblem(unsupported) });

    const truncated = `${base}/* orei:image-styles:v1 {"images":`;
    expect(imageStyleProblem(truncated)).toMatch(/malformed/);
    expect(applyImageStyle(truncated, reference, style)).toMatchObject({ problem: expect.stringMatching(/unterminated comment/) });
  });

  test('hidden markers inside CSS strings are not metadata', () => {
    const css = `.note::before { content: "/* orei:image-styles:v1 {bad} */"; }\n`;
    expect(imageStyleProblem(css)).toBeUndefined();
    expect(styled(css, reference, style).startsWith(css)).toBe(true);
  });

  test('non-canonical keys, unsupported references, duplicates and invalid values are malformed', () => {
    const entries = [
      '{"%70hoto.png":{"radius":1,"borderWidth":1,"borderColor":"#fff"}}',
      '{"..%2Foutside.png":{"radius":1,"borderWidth":1,"borderColor":"#fff"}}',
      '{"remote.png":{"radius":-1,"borderWidth":1,"borderColor":"#fff"}}',
      '{"remote.png":{"radius":1,"borderWidth":1,"borderColor":"url(https://example.test/x)"}}',
      '{"photo.png":{"radius":1,"borderWidth":1,"borderColor":"notacolor"}}',
      '{"photo.png":{"radius":1,"borderWidth":1,"borderColor":"rgb(1)"}}',
      '{"remote.png":{"radius":1,"borderWidth":"1","borderColor":"#fff"}}',
      '{"remote.png":{"radius":1,"borderWidth":1,"borderColor":"#fff","extra":true}}',
      '{"remote.png":{"radius":1,"borderWidth":1,"borderColor":"#fff","radius":2}}',
      '{"remote.png":{"radius":1,"borderWidth":1,"borderColor":"#fff"},"remote.png":{"radius":2,"borderWidth":1,"borderColor":"#fff"}}',
    ];
    for (const images of entries) {
      const css = `/* orei:image-styles:v1 {"images":${images}} */`;
      expect(imageStyleProblem(css), images).toMatch(/malformed/);
      expect(readImageStyles(css).styles.size).toBe(0);
    }
  });

  test('deeply nested malformed metadata is diagnosed without walking the invalid value', () => {
    const nested = '{"x":'.repeat(80000) + '0' + '}'.repeat(80000);
    const css = `/* orei:image-styles:v1 {"images":{"photo.png":${nested}}} */`;
    expect(imageStyleProblem(css)).toMatch(/malformed/);
    expect(readImageStyles(css).styles.size).toBe(0);
  });

  test('an unterminated comment or EOF string blocks a safe write', () => {
    const comment = `${base}/* user note`;
    expect(applyImageStyle(comment, reference, style)).toMatchObject({ problem: expect.stringMatching(/unterminated comment/) });
    const string = `${base}.x { content: "unterminated; }`;
    expect(applyImageStyle(string, reference, style)).toMatchObject({ problem: expect.stringMatching(/unterminated string/) });
  });

  test('a CSS bad-string ends at a newline and does not hide a managed block that follows', () => {
    const managed = styled(base, reference, style);
    const badString = `.x { content: "oops\n${managed}`;
    expect(readImageStyles(badString).styles.get(reference)).toEqual(style);
    const merged = styled(badString, reference, { radius: 20, borderWidth: 0, borderColor: '#000000' });
    expect(blockCount(merged)).toBe(1);
    expect(readImageStyles(merged).styles.get(reference)).toEqual({ radius: 20, borderWidth: 0, borderColor: '#000000' });
  });

  test('CRLF and CR-only stylesheets keep their line ending and reset exactly', () => {
    for (const newline of ['\r\n', '\r']) {
      const original = `/* palette */${newline}.a { color: red; }${newline}`;
      const withStyle = styled(original, reference, style);
      expect(withStyle).toContain(`}${newline}/* orei:image-styles`);
      expect(withStyle.endsWith(`*/${newline}`)).toBe(true);
      expect(styled(withStyle, reference, defaultImageStyle(original))).toBe(original);
    }
  });

  test('refuses styling that would push the stylesheet past the renderer limit', () => {
    const css = 'a'.repeat(MAX_STYLESHEET_TEXT - 10);
    expect(applyImageStyle(css, reference, style)).toMatchObject({
      problem: expect.stringMatching(/exceed the 50,000-character limit/),
    });
  });

  test('invalid form values are refused instead of persisted', () => {
    for (const values of [
      { radius: -1, borderWidth: 1, borderColor: '#fff' },
      { radius: Number.NaN, borderWidth: 1, borderColor: '#fff' },
      { radius: 1, borderWidth: Infinity, borderColor: '#fff' },
      { radius: 1, borderWidth: 1, borderColor: '#fff; color: red' },
      { radius: 1, borderWidth: 1, borderColor: 'var(--x)' },
      { radius: 1, borderWidth: 1, borderColor: 'notacolor' },
      { radius: 1, borderWidth: 1, borderColor: 'rgb(1)' },
      { radius: 1, borderWidth: 1, borderColor: 'inherit' },
      { radius: 1, borderWidth: 1 },
    ]) {
      expect(normalizeImageStyle(values)).toBeUndefined();
      expect(applyImageStyle(base, reference, values)).toMatchObject({ problem: expect.any(String) });
    }
    expect(normalizeImageStyle({ radius: 1.5, borderWidth: 2.25, borderColor: ' rgb(1, 2, 3) ' }))
      .toEqual({ radius: 1.5, borderWidth: 2.25, borderColor: 'rgb(1, 2, 3)' });
    // A lone surrogate can pass the relative-path shape test but cannot be encoded safely.
    expect(applyImageStyle(base, '\uD800.png', style)).toMatchObject({ problem: expect.stringMatching(/encoded safely/) });
  });

  test('default border color follows the current diagram palette', () => {
    expect(defaultImageStyle(base).borderColor).toBe('#0284c7');
    expect(defaultImageStyle('.pele { --pele-border: var(--x); }').borderColor).toBe(DEFAULT_IMAGE_BORDER_COLOR);
    expect(defaultImageStyle('').borderColor).toBe(DEFAULT_IMAGE_BORDER_COLOR);
    expect(isDefaultImageStyle(defaultImageStyle(base))).toBe(true);
  });
});

describe('reversible image reference keys', () => {
  const unusual = [
    'assets/my photo (1)#.png',
    'café/图片 (final).png',
    'assets/a*/b.png',
    'pasted-image-2.png',
    "assets/it's.png",
    'assets/100%.png',
    `${'图'.repeat(160)}.png`,
  ];

  test('round-trips unusual supported PNG paths without ending the CSS comment early', () => {
    const css = unusual.reduce((current, value) => styled(current, value, style), base);
    expect(blockCount(css)).toBe(1);
    // One terminator for the palette comment in `base`, one for the managed comment.
    expect(css.split('*/').length - 1).toBe(2);
    for (const value of unusual) {
      const key = encodeImageStyleKey(value);
      expect(key).toBe(encodeImageStyleKey(value));
      expect(key).not.toContain('*');
      expect(key).not.toContain('/');
      expect(decodeImageStyleKey(key)).toBe(value);
      expect(readImageStyles(css).styles.get(value)).toEqual(style);
    }
    expect(decodeImageStyleKey('assets%2Fphoto.png')).toBe('assets/photo.png');
    expect(decodeImageStyleKey('assets%2fphoto.png')).toBeUndefined();
    expect(decodeImageStyleKey('')).toBeUndefined();
    expect(decodeImageStyleKey('%2E%2E%2Foutside.png')).toBeUndefined();
  });

  test('labels the cog with its image reference', () => {
    expect(imageStyleControlLabel('assets/my photo.png')).toContain('assets/my photo.png');
  });

  test('the managed comment survives Markdown and paired stylesheet carriers', () => {
    const css = styled(base, 'assets/a*/b.png', style);
    const note = createMarkdownDocument({ mermaid: 'graph TD\n A-->B\n', css });
    const reopened = parseMarkdownDocument(note);
    expect(reopened.css).toBe(css);
    expect(readImageStyles(reopened.css).styles.get('assets/a*/b.png')).toEqual(style);
    expect(pairedSnapshot({ source: 'graph TD\n', css, assets: {} }, { base: 'diagram', cssCompanion: true, assetsCompanion: false }).css).toBe(css);
  });

  test('Save As and Copy conversions keep the managed comment in the stylesheet', () => {
    const css = styled(base, 'assets/a*/b.png', style);
    const document = { source: 'graph TD\n A-->B\n', css, assets: {} };
    // Markdown destination validation and inline stylesheet update must not strip the block.
    expect(planConversion(document, 'markdown')).toEqual({ format: 'markdown' });
    const note = updateMarkdownDocument(createMarkdownDocument({ mermaid: 'graph TD\n', css: '' }), {
      mermaid: document.source,
      css,
    });
    expect(parseMarkdownDocument(note).css).toBe(css);
    expect(readImageStyles(parseMarkdownDocument(note).css).styles.get('assets/a*/b.png')).toEqual(style);
    // Paired destination snapshots already carry the document stylesheet unchanged.
    const paired = planConversion(document, 'paired');
    if (paired.format !== 'paired') throw new Error('Expected a paired conversion');
    expect(paired.snapshot.css).toBe(css);
  });
});
