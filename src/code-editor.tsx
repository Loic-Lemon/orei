import { useId, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { TextArea } from '@radix-ui/themes';

type CodeEditorLanguage = 'mermaid' | 'css';

type CodeEditorProps = {
  ref: Ref<HTMLTextAreaElement>;
  language: CodeEditorLanguage;
  label: string;
  value: string;
  onChange: (value: string) => void;
};

type TokenRule = { source: string; className: string; punctuation?: RegExp };

const mermaidString = String.raw`"(?:[^"\\\r\n]|\\.)*(?:"|(?=[\r\n]|$))`;
const labelEnd = String.raw`(?=[\r\n]|$)`;
const shapeLabels = [
  String.raw`\[(?:${mermaidString}|[^\]"\r\n])*(?:\]|${labelEnd})`,
  String.raw`\((?:${mermaidString}|[^)"\r\n])*(?:\)|${labelEnd})`,
  String.raw`\{(?:${mermaidString}|[^}"\r\n])*(?:\}|${labelEnd})`,
  String.raw`\|(?:${mermaidString}|[^|"\r\n])*(?:\||${labelEnd})`,
].join('|');

// Match labels before identifiers so words inside a label keep a single color.
// Shape labels also match up to the end of a line while still being typed.
const tokenRules: Record<CodeEditorLanguage, TokenRule[]> = {
  mermaid: [
    { source: '%%[^\\n]*', className: 'tok-comment' },
    { source: shapeLabels, className: 'tok-label', punctuation: /([()[\]{}|"])/ },
    { source: String.raw`(?:--|==|-\.)[ \t]+\S[^\r\n]*?(?=(?:--[->ox]|==[=>]|\.-))`, className: 'tok-label', punctuation: /(^..[ \t]+|[ \t]+$)/ },
    { source: mermaidString, className: 'tok-string' },
    { source: '\\b(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|subgraph|end|direction|participant|actor|autonumber|activate|deactivate|note|over|loop|alt|else|opt|par|and|rect|classDef|class|style|click|linkStyle|accTitle|accDescr)\\b', className: 'tok-keyword' },
    { source: '\\b(?:TD|TB|BT|LR|RL)\\b', className: 'tok-direction' },
    { source: '<?-?\\.+-+>?|<?(?:--+|==+)[>ox]{0,2}|->[>]?|<-', className: 'tok-connector' },
    { source: '[()\\[\\]{}:;,]', className: 'tok-delimiter' },
    { source: String.raw`[\p{L}\d_][\p{L}\p{M}\d_]*(?:-[\p{L}\p{M}\d_]+)*`, className: 'tok-identifier' },
  ],
  css: [
    { source: '/\\*[\\s\\S]*?(?:\\*/|$)', className: 'tok-comment' },
    { source: "'(?:\\\\.|[^'\\\\\\n])*'|\"(?:\\\\.|[^\"\\\\\\n])*\"", className: 'tok-string' },
    { source: '#[0-9a-fA-F]{3,8}\\b|\\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\\b', className: 'tok-color' },
    { source: '--[\\w-]+', className: 'tok-variable' },
    { source: '@[\\w-]+', className: 'tok-keyword' },
    { source: '[A-Za-z][\\w-]*(?=[ \\t]*:)', className: 'tok-property' },
    { source: '\\b\\d+(?:\\.\\d+)?(?:%|[a-zA-Z]+)?', className: 'tok-number' },
  ],
};

const tokenRegexes: Record<CodeEditorLanguage, RegExp> = {
  mermaid: new RegExp(tokenRules.mermaid.map(rule => `(${rule.source})`).join('|'), 'gu'),
  css: new RegExp(tokenRules.css.map(rule => `(${rule.source})`).join('|'), 'g'),
};

function highlight(code: string, language: CodeEditorLanguage): ReactNode[] {
  const rules = tokenRules[language];
  const regex = tokenRegexes[language];
  regex.lastIndex = 0;
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(code))) {
    if (match[0].length === 0) { regex.lastIndex += 1; continue; }
    if (match.index > last) nodes.push(code.slice(last, match.index));
    const ruleIndex = rules.findIndex((_, index) => match![index + 1] !== undefined);
    const { className, punctuation } = rules[ruleIndex];
    const parts = punctuation ? match[0].split(punctuation) : [match[0]];
    parts.forEach((part, index) => {
      if (part) nodes.push(<span key={key++} className={index % 2 ? 'tok-delimiter' : className}>{part}</span>);
    });
    last = match.index + match[0].length;
  }
  if (last < code.length) nodes.push(code.slice(last));
  return nodes;
}

export function CodeEditor({ ref, language, label, value, onChange }: CodeEditorProps) {
  const gutter = useRef<HTMLSpanElement>(null);
  const layer = useRef<HTMLSpanElement>(null);
  const help = useId();
  const [composing, setComposing] = useState(false);
  const numbers = useMemo(
    () => value.split(/\r\n?|\n/).map((_, index) => index + 1).join('\n'),
    [value],
  );
  const tokens = useMemo(() => highlight(value, language), [value, language]);

  return <div className="code-editor" data-language={language}>
    <pre className="editor-line-numbers" aria-hidden="true"><span ref={gutter}>{numbers}</span></pre>
    <div className="editor-text" data-composing={composing || undefined}>
      <pre className="editor-highlight" aria-hidden="true"><span ref={layer}>{tokens}</span></pre>
      <TextArea
        ref={ref}
        aria-label={label}
        aria-describedby={help}
        value={value}
        spellCheck={false}
        wrap="off"
        onChange={event=>onChange(event.target.value)}
        onCompositionStart={()=>setComposing(true)}
        onCompositionEnd={()=>setComposing(false)}
        onBlur={()=>setComposing(false)}
        onScroll={event=>{
          const { scrollLeft, scrollTop } = event.currentTarget;
          if(gutter.current)gutter.current.style.transform=`translateY(${-scrollTop}px)`;
          if(layer.current)layer.current.style.transform=`translate(${-scrollLeft}px, ${-scrollTop}px)`;
        }}
      />
    </div>
    <span id={help} className="visually-hidden">Tab indents the selected lines; Shift+Tab removes one indent level. Press Escape then Tab to leave the editor.</span>
  </div>;
}
