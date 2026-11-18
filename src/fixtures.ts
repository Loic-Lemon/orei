import star from '../fixtures/custom.svg?raw';
import custom from '../fixtures/custom-iconify.json';
import local from '../fixtures/local.png?inline';
import type { DiagramDocument } from './rendering';
export const defaultCSS=`/* Global palette. Mermaid styles and stronger CSS can override these. */
.pele {
  --pele-bg: #ffffff;
  --pele-fg: #182230;
  --pele-line: #475569;
  --pele-surface: #e0f2fe;
  --pele-border: #0284c7;
  --pele-accent: #2563eb;
  --pele-font: sans-serif;
}`;
const assets={'fixture:star':star,'fixture:diamond':custom.icons.diamond.body,'assets/local.png':local};
const small=String.raw`flowchart LR
 A[Ordinary label] --> B["$$\frac{\alpha_1^2}{\beta}$$"]
 B --> C@{ icon: "lucide:house", form: "square", label: "Home" }
 C --> D@{ icon: "fixture:star", label: "Custom SVG" }
 D --> E@{ icon: "fixture:diamond", label: "Iconify fixture" }
 E --> F@{ img: "assets/local.png", label: "Local image", w: 64, h: 48 }`;
function grid(n:number,math=false) {
  return 'flowchart TB\n'+Array.from({length:n},(_,i)=>` N${i}["${math?`$$\\frac{\\alpha_${i}^2}{\\beta}+\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}$$`:`Step ${i}`} "]`).join('\n')+'\n'+Array.from({length:n},(_,i)=>i>=8?`N${i-8} --> N${i}`:'').join('\n');
}
export const fixtures:Record<string,DiagramDocument>={
  small:{source:small,css:defaultCSS,assets},
  medium:{source:grid(80),css:defaultCSS,assets},
  stress:{source:grid(320),css:defaultCSS,assets},
  'math-heavy':{source:grid(48,true),css:defaultCSS,assets},
};
