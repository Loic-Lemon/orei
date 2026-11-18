import {test,expect} from 'vitest';
import {importSvgIcon} from '../src/icon-import';
import {renderDiagram} from '../src/rendering';

const car='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#2563eb" stroke="none" d="M0 0h24v24H0z"/></svg>';

test('an imported icon is used by reference and materializes inside standalone SVG output',async()=>{
  const imported=importSvgIcon({namespace:'custom',name:'car',svg:car,existing:{}});
  const result=await renderDiagram({source:'flowchart LR\n A@{ icon: "custom:car", label: "Car" }',css:'',assets:{[imported.reference]:imported.body}},{mode:'fixed',width:400});
  const svg=new DOMParser().parseFromString(result.svg,'image/svg+xml');
  expect(svg.querySelector('[data-icon="custom:car"] path')).not.toBeNull();
  expect(svg.querySelector('[data-icon="custom:car"] path')?.getAttribute('fill')).toBe('#2563eb');
  expect(result.svg).not.toMatch(/(?:href|src)="(?:https?:|file:)/);
});

test('a missing or unsafe stored icon rejects the render instead of blanking it',async()=>{
  await expect(renderDiagram({source:'flowchart LR\n A@{ icon: "custom:missing" }',css:'',assets:{}},{mode:'fixed',width:400})).rejects.toThrow('Missing icon: custom:missing');
  await expect(renderDiagram({source:'flowchart LR\n A@{ icon: "custom:bad" }',css:'',assets:{'custom:bad':'<script>alert(1)</script>'}},{mode:'fixed',width:400})).rejects.toThrow('Unsupported icon content');
  await expect(renderDiagram({source:'flowchart LR\n A@{ icon: "custom:ext" }',css:'',assets:{'custom:ext':'<rect width="1" height="1" fill="url(https://example.invalid/a)"/>'}},{mode:'fixed',width:400})).rejects.toThrow('External or active icon resource');
});
