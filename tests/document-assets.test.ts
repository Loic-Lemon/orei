import {test,expect,describe} from 'vitest';
import {addAsset,assetKind,iconAssets,removeAsset} from '../src/document-assets';

describe('document asset map',()=>{
  test('classifies inline icon markup and image data',()=>{
    expect(assetKind('<svg xmlns="http://www.w3.org/2000/svg"/>')).toBe('icon');
    expect(assetKind('<path d="M0 0"/>')).toBe('icon');
    expect(assetKind('data:image/png;base64,AAAA')).toBe('image');
    expect(assetKind('')).toBe('unknown');
  });
  test('only icons are listed by the icon library',()=>{
    const assets={'a:one':'<svg/>','assets/local.png':'data:image/png;base64,AAAA','b:two':'<path/>','c:three':'<path/>','d:four':'<path/>'};
    expect(iconAssets(assets).map(([reference])=>reference)).toEqual(['a:one','b:two','c:three','d:four']);
  });
  test('add and remove are immutable',()=>{
    const before={'custom:car':'<svg/>'};
    const added=addAsset(before,'custom:van','<path/>');
    expect(before).toEqual({'custom:car':'<svg/>'});
    expect(added).toEqual({'custom:car':'<svg/>','custom:van':'<path/>'});
    const removed=removeAsset(added,'custom:car');
    expect(added).toEqual({'custom:car':'<svg/>','custom:van':'<path/>'});
    expect(removed).toEqual({'custom:van':'<path/>'});
    expect(removeAsset(removed,'missing:icon')).toBe(removed);
  });
});
