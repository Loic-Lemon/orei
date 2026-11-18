import { test, expect } from 'vitest';
import { renderDiagram } from '../src/rendering';

test('a diagram exports ordinary labels as standalone SVG text', async () => {
  const result = await renderDiagram({source:'flowchart LR\n A[Ordinary label] --> B[Output]',css:'.pele { --pele-surface: #e0f2fe; }',assets:{}},{mode:'fixed',width:320});
  const svg = new DOMParser().parseFromString(result.svg,'image/svg+xml');
  expect([...svg.querySelectorAll('text')].map(e=>e.textContent)).toContain('Ordinary label');
  expect(svg.documentElement.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg');
  expect(result.svg).toContain('#e0f2fe');
});

test('math exports fraction, scripts, Greek and matrix glyphs as independent vector artwork', async () => {
  const source=String.raw`flowchart LR
 A["$$\frac{\alpha_1^2}{\beta}+\begin{pmatrix}a&b\\c&d\end{pmatrix}$$"] --> B["$$\alpha_1^2$$"]`;
  const result=await renderDiagram({source,css:'',assets:{}},{mode:'fixed',width:900});
  const svg=new DOMParser().parseFromString(result.svg,'image/svg+xml');
  expect(svg.querySelectorAll('[data-mml-node] path').length).toBeGreaterThan(8);
  expect(svg.querySelector('foreignObject, use, [data-mml-node="merror"]')).toBeNull();
  expect(result.svg).not.toContain('\\frac');
});

test('bundled and supplied icons and local image travel inside the standalone output', async () => {
  const {fixtures}=await import('../src/fixtures');
  const result=await renderDiagram(fixtures.small,{mode:'fixed',width:900});
  const svg=new DOMParser().parseFromString(result.svg,'image/svg+xml');
  for(const name of ['lucide:house','fixture:star','fixture:diamond']) expect(svg.querySelector(`[data-icon="${name}"] path`)).not.toBeNull();
  expect(svg.querySelector('image')?.getAttribute('href')).toMatch(/^data:image\/png;base64,/);
  expect(result.svg).not.toMatch(/(?:href|src)="(?:https?:|assets\/)/);
});

test.each([
  {source:'flowchart LR\n A[OK]',css:'@import "https://example.invalid/style.css";'},
  {source:'flowchart LR\n A[OK]',css:'.pele { fill: url(https://example.invalid/a); }'},
  {source:'flowchart LR\n A@{ img: "https://example.invalid/a.png" }',css:''},
  {source:'flowchart LR\n A@{ icon: "missing:icon" }',css:''},
  {source:String.raw`flowchart LR
 A["$$\unknowncommand{x}$$"]`,css:''},
])('required or remote resource failures reject output: $source $css',async input=>{
  await expect(renderDiagram({...input,assets:{}},{mode:'fixed',width:900})).rejects.toThrow();
});


test('export materializes the active label color independently of its stylesheet',async()=>{
  const result=await renderDiagram({source:'flowchart LR\n A[Active color]',css:'.pele-label { fill: #b91c1c; }',assets:{}},{mode:'fixed',width:900});
  const svg=new DOMParser().parseFromString(result.svg,'image/svg+xml');
  expect((svg.querySelector('text') as unknown as SVGElement).style.fill).toMatch(/#b91c1c|rgb\(185, 28, 28\)/);
});
