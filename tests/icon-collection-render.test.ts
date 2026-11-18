import {expect,test} from 'vitest';
import {bundledIconMarkup} from '../src/bundled-icons';
import {emptyIconLibrary, importIconCollection, removeIconCollection, withIconReference} from '../src/icon-library';
import {decodePairedAssets, encodePairedAssets} from '../src/paired-document';
import {renderDiagram} from '../src/rendering';

const collection=()=>JSON.stringify({
  prefix:'acme',
  width:24,
  height:24,
  info:{name:'Acme icons',author:{name:'Acme Team'},license:{title:'MIT',spdx:'MIT'}},
  icons:{
    dot:{body:'<circle cx="12" cy="12" r="6"/>'},
    rotated:{body:'<path d="M0 0"/>',rotate:1},
  },
});

test('a used collection definition renders after the pack is removed and survives the paired index',async()=>{
  const {library}=importIconCollection(emptyIconLibrary(),collection());
  const assets=withIconReference({},library,'acme:rotated');
  expect(Object.keys(assets)).toEqual(['acme:rotated']);
  // Reopening is independent of the original import: the document carries the body.
  const withoutPack=removeIconCollection(library,'acme');
  expect(withoutPack.collections).toEqual([]);
  const result=await renderDiagram({source:'flowchart LR\n A@{ icon: "acme:rotated", label: "Turn" }',css:'',assets},{mode:'fixed',width:400});
  const svg=new DOMParser().parseFromString(result.svg,'image/svg+xml');
  const icon=svg.querySelector('[data-icon="acme:rotated"]');
  expect(icon).not.toBeNull();
  expect(icon!.innerHTML).toContain('rotate(90 12 12)');
  expect(result.svg).not.toMatch(/(?:href|src)="(?:https?:|file:)/);

  const index=encodePairedAssets(assets);
  expect(JSON.parse(index).assets['acme:rotated']).toMatchObject({kind:'icon',mediaType:'image/svg+xml',encoding:'text'});
  expect(decodePairedAssets(index)).toEqual(assets);
});

test('bundled aliases resolve through the collection instead of reporting a missing icon',async()=>{
  expect(bundledIconMarkup('activity-square')).toContain('<path');
  expect(bundledIconMarkup('not-a-lucide-icon')).toBeUndefined();
  const result=await renderDiagram({source:'flowchart LR\n A@{ icon: "lucide:activity-square" }',css:'',assets:{}},{mode:'fixed',width:400});
  expect(result.svg).toContain('data-icon="lucide:activity-square"');
});
