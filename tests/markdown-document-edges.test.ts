import { describe, expect, it } from 'vitest';
import { createMarkdownDocument, parseMarkdownDocument, updateMarkdownDocument } from '../src/markdown-document';

const original = { mermaid: 'graph TD\n  old --> end\n', css: '.old { color: red; }\n' };
const note = createMarkdownDocument(original);

describe('Markdown document edge cases', () => {
  it('round-trips empty mermaid and stylesheet blocks through create, parse and update', () => {
    const created = createMarkdownDocument({ mermaid: '', css: '' });
    expect(created).toBe('```mermaid\n```\n\n<!-- orei:css:start -->\n```css\n```\n<!-- orei:css:end -->\n');
    expect(parseMarkdownDocument(created)).toEqual({ mermaid: '', css: '' });
    expect(updateMarkdownDocument(created, { mermaid: '', css: '' })).toBe(created);
    const cleared = updateMarkdownDocument(note, { mermaid: '', css: '' });
    expect(parseMarkdownDocument(cleared)).toEqual({ mermaid: '', css: '' });
    expect(updateMarkdownDocument(cleared, original)).toBe(note);
  });

  it('fills both empty blocks from a document without terminal newlines in the content', () => {
    const updated = updateMarkdownDocument(note, { mermaid: 'graph LR', css: '.pele {}' });
    expect(updateMarkdownDocument(updated, { mermaid: 'a', css: 'b' })).toBe(
      createMarkdownDocument({ mermaid: 'a\n', css: 'b\n' }),
    );
  });

  it('counts indented and tab-suffixed backtick lines when choosing the created fence', () => {
    const document = { mermaid: ' ```\t\n  ```\n    ````\n', css: '' };
    const created = createMarkdownDocument(document);
    expect(created.startsWith('````mermaid\n')).toBe(true);
    expect(parseMarkdownDocument(created)).toEqual(document);
  });

  it('round-trips CR-only line endings inside block content', () => {
    const document = { mermaid: 'A\rB', css: 'X\rY' };
    const created = createMarkdownDocument(document);
    expect(parseMarkdownDocument(created)).toEqual({ mermaid: 'A\rB\n', css: 'X\rY\n' });
    expect(parseMarkdownDocument(updateMarkdownDocument(created, document))).toEqual({ mermaid: 'A\rB\n', css: 'X\rY\n' });
  });

  it('accepts frontmatter terminated by dots', () => {
    const source = '---\ntitle: x\n...\n\n' + note;
    expect(parseMarkdownDocument(source)).toEqual(original);
    expect(updateMarkdownDocument(source, { mermaid: 'graph LR\n', css: '.new {}\n' })).toBe(
      '---\ntitle: x\n...\n\n' + createMarkdownDocument({ mermaid: 'graph LR\n', css: '.new {}\n' }),
    );
  });

  it('returns the source unchanged when the replacement equals the current content', () => {
    expect(updateMarkdownDocument(note, original)).toBe(note);
  });

  it.each([
    '<!-- orei:css:start --> ',
    '<!-- orei:css:end -->\t',
  ])('rejects marker lines with trailing whitespace: %j', marker => {
    expect(() => parseMarkdownDocument(note.replace(marker.trim(), marker))).toThrow('malformed CSS markers');
  });

  it('rejects an extra fenced block between the CSS markers', () => {
    const source = '<!-- orei:css:start -->\n```css\nx\n```\n```mermaid\ny\n```\n<!-- orei:css:end -->\n';
    expect(() => parseMarkdownDocument(source)).toThrow('exactly one CSS fence');
  });

  it('rejects a fence-like line of equal length with trailing whitespace when replacing', () => {
    expect(() => updateMarkdownDocument(note, { mermaid: '``` \t\n', css: '' })).toThrow('close the existing fence');
  });

  it('accepts a shorter backtick run and a different fence character inside the existing fence', () => {
    const updated = updateMarkdownDocument(note, { mermaid: '``\n~~~\n', css: original.css });
    expect(parseMarkdownDocument(updated)).toEqual({ mermaid: '``\n~~~\n', css: original.css });
  });

  it('checks the fence safety of the stylesheet block too', () => {
    expect(() => updateMarkdownDocument(note, { mermaid: original.mermaid, css: '```\n' })).toThrow('close the existing fence');
    expect(parseMarkdownDocument(updateMarkdownDocument(note, { mermaid: original.mermaid, css: '~~~\n' }))).toEqual({ mermaid: original.mermaid, css: '~~~\n' });
  });
});
