import {expect,test} from 'vitest';
import {fixtures} from '../src/fixtures';
import {diagramSchemes} from '../src/diagram-presets';
import {paletteValues} from '../src/palette';
import {renderDiagram} from '../src/rendering';
import {DRAFTS_KEY, WORKSPACE_VERSION, WORKSPACE_VERSION_KEY, freshWorkspace, isUntouchedSampleWorkspace, restoreWorkspace} from '../src/workspace';

const storage=(values:Record<string,string>={}):Pick<Storage,'getItem'>=>({getItem:key=>values[key]??null});
const legacy=(documents:Record<string,unknown>,active?:string)=>storage({
  [DRAFTS_KEY]:JSON.stringify({documents,active}),
});

test('a clean launch opens one sample-free Untitled 1',()=>{
  const workspace=restoreWorkspace(storage());
  expect(Object.keys(workspace.documents)).toEqual(['Untitled 1']);
  expect(workspace.active).toBe('Untitled 1');
  expect(workspace.blocked).toBeUndefined();
  const document=workspace.documents['Untitled 1'];
  expect(document.source).toBe('flowchart TD\n  A[Start] --> B[End]');
  expect(paletteValues(document.css)).toMatchObject(diagramSchemes.graphite.colors);
  expect(document.assets).toEqual({});
  expect(Object.keys(document.assets)).toEqual([]);
  expect(JSON.stringify(document)).not.toContain('fixture:');
  expect(JSON.stringify(document)).not.toContain('assets/local.png');
});

test('the clean diagram is a valid render',async()=>{
  const document=restoreWorkspace(storage()).documents['Untitled 1'];
  const snapshot=await renderDiagram(document,{mode:'fixed',width:800});
  expect(snapshot.width).toBeGreaterThan(0);
  expect(snapshot.svg).toContain('Start');
  expect(snapshot.svg).toContain('End');
});

test('an untouched fixture-only workspace from the previous release is migrated away',()=>{
  expect(isUntouchedSampleWorkspace({...fixtures})).toBe(true);
  const workspace=restoreWorkspace(legacy({...fixtures},'medium'));
  expect(Object.keys(workspace.documents)).toEqual(['Untitled 1']);
  expect(workspace.active).toBe('Untitled 1');
});

test('edited fixture tabs and their workspace are preserved',()=>{
  const documents={...fixtures,small:{...fixtures.small,source:'flowchart TD\n  A[Edited sample] --> B'},medium:{...fixtures.medium,assets:{'fixture:star':fixtures.small.assets['fixture:star']}}};
  expect(isUntouchedSampleWorkspace(documents)).toBe(false);
  const workspace=restoreWorkspace(legacy(documents,'small'));
  expect(Object.keys(workspace.documents)).toHaveLength(4);
  expect(workspace.documents.small.source).toContain('Edited sample');
  expect(workspace.active).toBe('small');
});

test('a workspace deliberately seeded with samples is preserved',()=>{
  const storage=legacy({...fixtures},'small');
  const versioned={getItem:((original)=>(key:string)=>key===WORKSPACE_VERSION_KEY?WORKSPACE_VERSION:original(key))(storage.getItem)};
  const workspace=restoreWorkspace(versioned);
  expect(Object.keys(workspace.documents)).toHaveLength(4);
  expect(workspace.active).toBe('small');
});

test('unreadable recovery data is preserved and reported on a clean fallback',()=>{
  const workspace=restoreWorkspace(storage({[DRAFTS_KEY]:'{broken'}));
  expect(workspace.blocked).toBe(true);
  expect(Object.keys(workspace.documents)).toEqual(['Untitled 1']);
  expect(freshWorkspace().documents['Untitled 1']).toEqual(workspace.documents['Untitled 1']);
});

test('the legacy active key still selects a restored tab',()=>{
  const workspace=restoreWorkspace(storage({
    [DRAFTS_KEY]:JSON.stringify({documents:{one:{source:'graph TD',css:'',assets:{}},two:{source:'graph LR',css:'',assets:{}}}}),
    'orei-active-v1':'two',
  }));
  expect(workspace.active).toBe('two');
  expect(Object.keys(workspace.documents)).toEqual(['one','two']);
});
