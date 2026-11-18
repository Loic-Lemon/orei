import {expect,test} from 'vitest';
import {applyPalette,paletteRule,paletteValue,rewritePalette} from '../src/palette';

test('palette edits preserve unrelated rules, comments, and whitespace',()=>{
  const css='/* before */\n.pele {\n /* label */\n --pele-bg: #ffffff;\n color: red;\n}\n.node { fill: blue; }';
  expect(paletteValue(css,'--pele-bg')).toBe('#ffffff');
  expect(rewritePalette(css,'--pele-bg','#123456')).toBe(css.replace('#ffffff','#123456'));
});
test.each(['.pele { --pele-bg: red;', '.pele { --pele-bg: red; } .pele { color: blue; }', '.pele { --pele-bg: red; --pele-bg: blue; }', '@media screen { .pele { color: red; } }', '.pele { --pele-bg: red; } /* incomplete'])('unsafe or ambiguous CSS pauses rewriting: %s',css=>{
  expect(paletteRule(css)).toBeUndefined();
  expect(rewritePalette(css,'--pele-bg','#123456')).toBeUndefined();
});

test('repeated edits preserve a final declaration without a semicolon',()=>{
  const css='.pele {\n  --pele-bg: #ffffff\n}';
  const first=rewritePalette(css,'--pele-bg','#123456')!;
  const second=rewritePalette(first,'--pele-bg','#abcdef')!;
  expect(second).toBe('.pele {\n  --pele-bg: #abcdef\n}');
  expect(paletteValue(second,'--pele-bg')).toBe('#abcdef');
});

test('missing and temporarily empty variables can be edited',()=>{
  const css='.pele { color: red; }';
  const added=rewritePalette(css,'--pele-bg','#123456')!;
  const cleared=rewritePalette(added,'--pele-bg','')!;
  expect(paletteRule(cleared)).toBeDefined();
  expect(paletteValue(rewritePalette(cleared,'--pele-bg','#abcdef')!,'--pele-bg')).toBe('#abcdef');
});

test('presets create a missing global palette without replacing authored rules',()=>{
  const css='.pele-node { opacity: .9; }';
  const colors={'--pele-bg':'#fafafa','--pele-fg':'#252525'};
  const updated=applyPalette(css,colors)!;
  expect(updated.endsWith(css)).toBe(true);
  expect(updated).toContain('  --pele-bg: #fafafa;\n  --pele-fg: #252525;');
  expect(paletteValue(updated,'--pele-fg')).toBe('#252525');
  expect(applyPalette(updated,colors)).toBe(updated);
  expect(applyPalette('.pele { color: red; } .pele {}',colors)).toBeUndefined();
});
