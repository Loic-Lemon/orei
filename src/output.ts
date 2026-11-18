import {save} from '@tauri-apps/plugin-dialog';
import {invoke} from '@tauri-apps/api/core';
import type {Snapshot} from './rendering';

/** Accepted PNG resource limits for the exported composition. */
export const pngLimits={maxSide:16384,maxPixels:64_000_000} as const;

/**
 * Validates the offered scale against the accepted resource limits and rounds the
 * raster dimensions up, so a fractional composition never loses a pixel column.
 */
export function pngDimensions(width:number,height:number,scale:number):{width:number;height:number}{
  const scaled={width:Math.ceil(width*scale),height:Math.ceil(height*scale)};
  if(![1,2,4].includes(scale)||scaled.width<1||scaled.height<1||scaled.width>pngLimits.maxSide||scaled.height>pngLimits.maxSide||scaled.width*scaled.height>pngLimits.maxPixels)
    throw new Error('PNG export exceeds the accepted limits: offered scales are 1×, 2× and 4×, with at most 16,384 px per side and 64 million pixels');
  return scaled;
}

/** A parsed snapshot prepared for rasterization: transparent option applied, dimensions validated. */
export interface PreparedSvg { svg:string; background:string; width:number; height:number }

/**
 * Applies the canvas-background/transparency choice to a current snapshot. The canvas
 * rect is the only element removed; opaque shapes keep their own fills untouched, so
 * transparent compositing never recolors them. Returns the background color used when
 * the document background is requested.
 */
export function prepareSvg(snapshot:Snapshot,transparent=false):PreparedSvg{
  const {width,height}=pngDimensions(snapshot.width,snapshot.height,1);
  const parsed=new DOMParser().parseFromString(snapshot.svg,'image/svg+xml').documentElement;
  if(transparent)parsed.querySelector('[data-orei-canvas]')?.remove();
  return {svg:new XMLSerializer().serializeToString(parsed),background:parsed.getAttribute('data-orei-background')??'#ffffff',width,height};
}

export async function png(snapshot:Snapshot,scale:number,transparent=false):Promise<Blob>{
  const prepared=prepareSvg(snapshot,transparent);
  const {width,height}=pngDimensions(prepared.width,prepared.height,scale);
  const url=URL.createObjectURL(new Blob([prepared.svg],{type:'image/svg+xml'}));
  try{
    const image=new Image();image.src=url;await image.decode();
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Canvas unavailable');
    if(!transparent){ctx.fillStyle=prepared.background;ctx.fillRect(0,0,width,height);}
    ctx.drawImage(image,0,0,width,height);
    return await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('PNG encoding failed')),'image/png'));
  }finally{URL.revokeObjectURL(url);}
}
export async function saveSnapshot(snapshot:Snapshot,format:'svg'|'png',scale:number,transparent:boolean){
  const bytes=format==='svg'?new TextEncoder().encode(snapshot.svg):new Uint8Array(await (await png(snapshot,scale,transparent)).arrayBuffer());
  const path=await save({defaultPath:`diagram.${format}`,filters:[{name:format.toUpperCase(),extensions:[format]}]});
  if(path)await invoke('save_output',{path,bytes:Array.from(bytes)});
}

/**
 * Clipboard output through the native seam, distinct from the file destinations: the
 * image reuses the PNG pipeline with the chosen scale and canvas settings, the SVG is
 * the same standalone snapshot markup a save writes, and the Mermaid source is copied
 * as plain text (staying available while rendering is invalid).
 */
export async function copyImage(snapshot:Snapshot,scale:number,transparent=false):Promise<void>{
  const bytes=new Uint8Array(await (await png(snapshot,scale,transparent)).arrayBuffer());
  await invoke('copy_output_image',{bytes:Array.from(bytes)});
}
export async function copySvg(snapshot:Snapshot):Promise<void>{
  await invoke('copy_output_text',{text:snapshot.svg});
}
export async function copyText(text:string):Promise<void>{
  await invoke('copy_output_text',{text});
}
export async function copySource(source:string):Promise<void>{
  await copyText(source);
}
