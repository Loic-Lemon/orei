import { describe, expect, it } from 'vitest';
import { createMarkdownDocument, parseMarkdownDocument, updateMarkdownDocument } from '../src/markdown-document';

const original = { mermaid: 'graph TD\n  old --> end\n', css: '.old { color: red; }\n' };
const replacement = { mermaid: 'graph LR\n  new --> end\n', css: '.new { color: blue; }\n' };
const note = createMarkdownDocument(original);

describe('Markdown document', () => {
  it('creates safe fences, a marked empty stylesheet, and terminal line endings', () => {
    const created = createMarkdownDocument({ mermaid: 'a\n```\nb\n   `````\nc', css: '' });
    expect(created.startsWith('``````mermaid\n')).toBe(true);
    expect(parseMarkdownDocument(created)).toEqual({ mermaid: 'a\n```\nb\n   `````\nc\n', css: '' });
    expect(created).toContain('<!-- orei:css:start -->\n```css\n```\n<!-- orei:css:end -->\n');
  });

  it.each(['\n', '\r\n', '\r'])('preserves BOM, frontmatter, source content and %j delimiters', newline => {
    const frontmatter = '\ufeff---\ntitle: "é %% <div>"\nexample: |\n  ```mermaid\n  fake\n  ```\n  <!-- orei:css:start -->\n...\n';
    const mermaid = '  A["é &amp;"] --> B\n';
    const css = '  .node { content: "&#65; %%"; }\n';
    const source = (frontmatter + '# Heading\n\n   ~~~~mermaid sample\n' + mermaid + '  ~~~~~~ \t\n\n<!-- orei:css:start -->\n  ````css\n' + css + ' ```\n `````\t\n<!-- orei:css:end -->\nend').replaceAll('\n', newline);
    expect(parseMarkdownDocument(source)).toEqual({ mermaid: mermaid.replaceAll('\n', newline), css: (css + ' ```\n').replaceAll('\n', newline) });
    const next = { mermaid: 'changed\n'.replaceAll('\n', newline), css: 'style\n'.replaceAll('\n', newline) };
    expect(updateMarkdownDocument(source, next)).toBe(source.replace(mermaid.replaceAll('\n', newline), next.mermaid).replace((css + ' ```\n').replaceAll('\n', newline), next.css));
  });

  it('keeps the BOM when the first line is the Mermaid fence', () => {
    const source = '\ufeff' + note;
    expect(parseMarkdownDocument(source)).toEqual(original);
    expect(updateMarkdownDocument(source, replacement)).toBe('\ufeff' + createMarkdownDocument(replacement));
  });

  it.each([
    '<script>\n```mermaid\nfake\n```\n</script>',
    '<div>\n<!-- orei:css:start -->\n```css\nfake\n```\n<!-- orei:css:end -->\n```mermaid\nfake\n```\n</div>',
    '<!--\n```mermaid\nfake\n```\n<!-- orei:css:start -->\n-->',
    '<?instruction\n```mermaid\nfake\n```\n?>',
    '<![CDATA[\n```mermaid\nfake\n```\n]]>',
    '<!DOCTYPE example\n```mermaid\nfake\n```\n>',
    '> ```mermaid\n> fake\n> ```\n> <!-- orei:css:start -->\n> ```css\n> fake\n> ```\n> <!-- orei:css:end -->',
    '- item\n  ```mermaid\n  fake\n  ```\n\n  <!-- orei:css:start -->\n  ```css\n  fake\n  ```\n  <!-- orei:css:end -->',
    '1. item\n   > ```mermaid\n   > fake\n   > ```',
    '    ```mermaid\n    fake\n    ```\n    <!-- orei:css:start -->',
    '~~~text\n```mermaid\nfake\n```\n<!-- orei:css:start -->\n<!-- orei:css:end -->\n~~~',
    '%%\n```mermaid\nfake\n```\n<!-- orei:css:start -->\n```css\nfake\n```\n<!-- orei:css:end -->\n%%',
  ])('preserves surrounding Markdown and ignores nested example %j', example => {
    const source = example + '\n\n' + note + '\n' + example + '\n';
    expect(parseMarkdownDocument(source)).toEqual(original);
    expect(updateMarkdownDocument(source, replacement)).toBe(example + '\n\n' + createMarkdownDocument(replacement) + '\n' + example + '\n');
  });

  it('resolves Markdown again after comments hide unmatched fences or HTML', () => {
    const examples = '%%\n```mermaid\nunclosed example\n%%\n\n%%\n<div>\nunclosed example\n%%\n\n';
    const source = examples + note + '\ninline %% hidden %% comment, `%%` and <span data-value="%%">HTML</span>.\n';
    expect(parseMarkdownDocument(source)).toEqual(original);
    expect(updateMarkdownDocument(source, replacement)).toBe(source.replace(original.mermaid, replacement.mermaid).replace(original.css, replacement.css));
  });

  it('preserves literal comment delimiters in code and unrelated unclosed examples', () => {
    const document = { mermaid: 'A["%%"] --> B\n', css: '.node { content: "%%"; }\n' };
    const source = 'An inline `%%` example.\n\n' + createMarkdownDocument(document) + '\n```text\nunclosed example\n';
    expect(parseMarkdownDocument(source)).toEqual(document);
    expect(updateMarkdownDocument(source, replacement)).toBe(source.replace(document.mermaid, replacement.mermaid).replace(document.css, replacement.css));
  });

  it('preserves escaped comment markers and does not close a comment at an escaped marker', () => {
    const example = '\\%% literal\n\n%%\n\\%%\n```mermaid\nfake\n```\n%%\n\n';
    expect(parseMarkdownDocument(example + note)).toEqual(original);
    expect(updateMarkdownDocument(example + note, replacement)).toBe(example + createMarkdownDocument(replacement));
  });

  it('updates either source order without changing fence lines or surrounding whitespace', () => {
    const [diagram, stylesheet] = note.split('\n\n');
    const source = '# Note\n\n' + stylesheet + '\n' + diagram + '\n\nTail without newline';
    expect(updateMarkdownDocument(source, replacement)).toBe(source.replace(original.mermaid, replacement.mermaid).replace(original.css, replacement.css));
  });

  it.each([
    note + '```mermaid\nsecond\n```\n',
    note + '~~~mermaid extra metadata\nsecond\n~~~\n',
    note.replace('```mermaid\n', '```text\n'),
    note.replace('<!-- orei:css:end -->', ''),
    note + '<!-- orei:css:start -->\n',
    note + '<!-- orei:css:unknown -->\n',
    note.replace('<!-- orei:css:start -->', '<!--orei:css:start-->'),
    note.replace('<!-- orei:css:start -->', ' <!-- orei:css:start -->'),
    note.replace('```css\n', '```text\n'),
    note.replace('<!-- orei:css:end -->', '```css\nsecond\n```\n<!-- orei:css:end -->'),
    note.replace('```css\n', 'prose\n```css\n'),
    note.replace('```css\n', '\n```css\n'),
    note.replace('<!-- orei:css:end -->', '\n<!-- orei:css:end -->'),
    note.replace('```css\n', '> ```css\n').replace(original.css, '> style\n'),
    '---\nunclosed frontmatter\n' + note,
    note + '\n%% unclosed comment',
    note.slice(note.indexOf('<!-- orei:css:start -->')) + '\n```mermaid\nunclosed target\n',
  ])('rejects missing, ambiguous or malformed boundaries %j', source => {
    expect(() => parseMarkdownDocument(source)).toThrow();
    expect(() => updateMarkdownDocument(source, replacement)).toThrow();
  });

  it('does not select the only diagram or marker block from a quote', () => {
    expect(() => parseMarkdownDocument(note.replace('```mermaid\n' + original.mermaid + '```', '> ```mermaid\n> fake\n> ```'))).toThrow('Mermaid fence');
    expect(() => parseMarkdownDocument(note.split('\n').map(line => '> ' + line).join('\n'))).toThrow('CSS markers');
  });

  it.each(['```\n', '   ```` \t\n'])('rejects content that would destroy the existing boundary: %j', mermaid => {
    expect(() => updateMarkdownDocument(note, { mermaid, css: '' })).toThrow();
  });

  it('adds the boundary line ending to edits without a terminal newline', () => {
    const updated = updateMarkdownDocument(note, { mermaid: 'graph LR', css: '.pele {}' });
    expect(parseMarkdownDocument(updated)).toEqual({ mermaid: 'graph LR\n', css: '.pele {}\n' });
  });

  it('checks the selected fence character and length when replacing', () => {
    const source = note.replace('```mermaid', '~~~~mermaid').replace(original.mermaid + '```', original.mermaid + '~~~~~');
    const mermaid = '```\n~~~\n    ~~~~\n';
    expect(parseMarkdownDocument(updateMarkdownDocument(source, { mermaid, css: '' }))).toEqual({ mermaid, css: '' });
    expect(() => updateMarkdownDocument(source, { mermaid: '~~~~\n', css: '' })).toThrow('close the existing fence');
  });

  it('reports an unclosed target at the final newline', () => {
    const source = note.slice(note.indexOf('<!-- orei:css:start -->')) + '\n```mermaid\nunfinished\n';
    expect(() => parseMarkdownDocument(source)).toThrow('unclosed target fence');
  });
});
