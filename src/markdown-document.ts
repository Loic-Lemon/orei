import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Code, Nodes } from 'mdast';

export type MarkdownDocument = { mermaid: string; css: string };

type Fence = { start: number; end: number; char: string; length: number; openingStart: number; closingEnd: number };
const startMarker = '<!-- orei:css:start -->';
const endMarker = '<!-- orei:css:end -->';

function commentMarker(text: string, offset: number): number {
  let marker = text.indexOf('%%', offset);
  while (marker >= 0) {
    let start = marker;
    while (start > 0 && text[start - 1] === '\\') start--;
    if ((marker - start) % 2 === 0) return marker;
    marker = text.indexOf('%%', marker + 2);
  }
  return -1;
}

function inspect(text: string) {
  // Mask extensions without changing source offsets; mdast values normalize line endings and indentation.
  const bom = text.startsWith('\ufeff') ? 1 : 0;
  const source = text.slice(bom);
  const lines = [...source.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)].filter(m => m[0].length);
  const raw = (line: typeof lines[number]) => line[0].replace(/[\r\n]+$/, '');
  const mask = (value: string) => value.replace(/[^\r\n]/g, ' ');
  let markdown = source;
  if (lines[0] && /^---[ \t]*$/.test(raw(lines[0]))) {
    const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)[ \t]*$/.test(raw(line)));
    if (end < 0) throw new Error('Malformed Markdown: unclosed frontmatter');
    const offset = lines[end].index! + lines[end][0].length;
    markdown = mask(source.slice(0, offset)) + source.slice(offset);
  }

  let tree = fromMarkdown(markdown);
  let cursor = 0;
  while (true) {
    const opaque: { start: number; end: number }[] = [];
    const visit = (node: Nodes) => {
      if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html') {
        opaque.push({ start: node.position!.start.offset!, end: node.position!.end.offset! });
      } else if ('children' in node) node.children.forEach(visit);
    };
    visit(tree);
    let start = commentMarker(markdown, cursor);
    while (start >= 0) {
      const context = opaque.find(range => start >= range.start && start < range.end);
      if (!context) break;
      start = commentMarker(markdown, context.end);
    }
    if (start < 0) break;
    const end = commentMarker(markdown, start + 2);
    if (end < 0) throw new Error('Malformed Markdown: unclosed Obsidian comment');
    cursor = end + 2;
    markdown = markdown.slice(0, start) + mask(markdown.slice(start, cursor)) + markdown.slice(cursor);
    // Comments can hide unmatched fences or HTML, so resolve subsequent contexts again.
    tree = fromMarkdown(markdown);
  }

  const fence = (node: Code): Fence => {
    const opening = lines[node.position!.start.line - 1];
    const closing = lines[node.position!.end.line - 1];
    if (!opening || !closing) throw new Error('Malformed Markdown: unclosed target fence');
    const open = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(raw(opening));
    const close = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(raw(closing));
    if (!open || !close || opening === closing || close[2][0] !== open[2][0] || close[2].length < open[2].length) {
      throw new Error('Malformed Markdown: unclosed target fence');
    }
    return {
      start: bom + opening.index! + opening[0].length,
      end: bom + closing.index!,
      char: open[2][0],
      length: open[2].length,
      openingStart: bom + opening.index!,
      closingEnd: bom + closing.index! + closing[0].length,
    };
  };
  const markers: { value: string; index: number; end: number; nodeIndex: number }[] = [];
  tree.children.forEach((node, nodeIndex) => {
    if (node.type !== 'html' || node.position!.start.line !== node.position!.end.line) return;
    const line = lines[node.position!.start.line - 1];
    const value = raw(line);
    if (!/^ {0,3}<!--[ \t]*orei:css:/.test(value)) return;
    if (value !== startMarker && value !== endMarker) throw new Error('Missing, duplicate, or malformed CSS markers');
    markers.push({ value, index: bom + line.index!, end: bom + line.index! + line[0].length, nodeIndex });
  });
  if (markers.length !== 2 || markers[0].value !== startMarker || markers[1].value !== endMarker) throw new Error('Missing, duplicate, or malformed CSS markers');
  const [a, b] = markers;
  const cssNode = tree.children[a.nodeIndex + 1];
  if (b.nodeIndex !== a.nodeIndex + 2 || cssNode?.type !== 'code' || cssNode.lang !== 'css') throw new Error('CSS markers must contain exactly one CSS fence');
  const css = fence(cssNode);
  if (css.openingStart !== a.end || css.closingEnd !== b.index) throw new Error('Malformed CSS block');
  const diagrams = tree.children.filter((node, index): node is Code => node.type === 'code' && node.lang === 'mermaid' && (index < a.nodeIndex || index > b.nodeIndex));
  if (diagrams.length !== 1) throw new Error('Missing or ambiguous Mermaid fence');
  return { mermaid: fence(diagrams[0]), css };
}

export function parseMarkdownDocument(text: string): MarkdownDocument {
  const blocks = inspect(text);
  return { mermaid: text.slice(blocks.mermaid.start, blocks.mermaid.end), css: text.slice(blocks.css.start, blocks.css.end) };
}

export function updateMarkdownDocument(text: string, document: MarkdownDocument): string {
  const blocks = inspect(text);
  const changes = (['mermaid', 'css'] as const).map(key => ({ ...blocks[key], content: document[key] }));
  for (const block of changes) {
    if (block.content && !/[\r\n]$/.test(block.content)) {
      // `block.end` points at the closing fence character, so the text there never starts
      // with a line ending; use the document's own line-ending style instead.
      block.content += text.match(/\r\n|\r|\n/)?.[0] ?? '\n';
    }
    if (block.content && !/[\r\n]$/.test(block.content)) throw new Error('Block content must end with a line ending');
    const unsafe = block.content.split(/\r\n|\r|\n/).some(line => {
      const match = /^( {0,3})(`+|~+)\s*$/.exec(line);
      return match && match[2][0] === block.char && match[2].length >= block.length;
    });
    if (unsafe) throw new Error('Content would close the existing fence');
  }
  for (const block of changes.sort((a, b) => b.start - a.start)) text = text.slice(0, block.start) + block.content + text.slice(block.end);
  return text;
}

export function createMarkdownDocument(document: MarkdownDocument): string {
  const fence = (content: string) => {
    const longest = Math.max(2, ...content.split(/\r\n|\r|\n/).map(line => /^( {0,3})(`+)\s*$/.exec(line)?.[2].length ?? 0));
    return '`'.repeat(longest + 1);
  };
  const content = (value: string) => value && !/[\r\n]$/.test(value) ? value + '\n' : value;
  const m = fence(document.mermaid), c = fence(document.css);
  return `${m}mermaid\n${content(document.mermaid)}${m}\n\n${startMarker}\n${c}css\n${content(document.css)}${c}\n${endMarker}\n`;
}
