import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../src/server.js';

test('asset queries page, isolate sources, retain a stable insertion boundary and resolve bounded IDs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'zhilume-asset-query-'));
  const app = await createApp({root, token:'query-test'}), store = (app as any).store;
  t.after(async () => { await app.close(); if (resolve(root).startsWith(resolve(tmpdir()) + sep + 'zhilume-asset-query-')) await rm(root,{recursive:true,force:true}); });
  const headers = {authorization:'Bearer query-test'};
  const query = (body: any) => app.inject({method:'POST',url:'/api/v1/assets/query',headers,payload:body});
  const project = (await app.inject({method:'POST',url:'/api/v1/projects',headers,payload:{name:'query'}})).json();
  store.atomic(() => { for (let i=0;i<10000;i++) store.put('asset',{id:`a${i}`,kind:i%2?'audio':'image',filename:`素材-${i}.png`,size:100,storageKey:'private',metadata:{status:'ready',width:10,height:20}}); });
  store.put('asset',{id:'staged',kind:'image',filename:'暂存',staged:true});
  store.put('library',{id:'fav',projectId:project.id,assetId:'a2',name:'特别收藏'});
  // Query must not deserialize a complete collection.
  const originalAll = store.all.bind(store); store.all = (kind: string) => { assert.notEqual(kind,'asset'); return originalAll(kind); };
  const input = {source:'service',kinds:['image'],limit:24};
  const started=performance.now(), first=(await query(input)).json();
  t.diagnostic(`10,000 assets, first query ${Math.round(performance.now()-started)} ms, response ${JSON.stringify(first).length} bytes`);
  assert.equal(first.items.length,24); assert.equal(first.items[0].id,'a9998'); assert.ok(first.nextCursor);
  assert.ok(!('storageKey' in first.items[0]));
  store.put('asset',{id:'new',kind:'image',filename:'新增.png'});
  const second=(await query({...input,cursor:first.nextCursor})).json();
  assert.equal(second.items.length,24); assert.equal(second.items[0].id,'a9950');
  assert.equal((await query({...input,q:'changed',cursor:first.nextCursor})).statusCode,400);
  assert.equal((await query({...input,cursor:'broken'})).statusCode,400);
  assert.equal((await query({...input,limit:1000})).statusCode,400);
  const favorites=(await query({source:'library',projectId:project.id,q:'特别'})).json();
  assert.deepEqual(favorites.items.map((a:any)=>a.id),['a2']);
  const canvas=(await query({source:'canvas',projectId:project.id,assetIds:['a4','a4','a8','staged','missing']})).json();
  assert.deepEqual(canvas.items.map((a:any)=>a.id),['a8','a4']);
  assert.equal((await query({source:'library',projectId:'missing'})).statusCode,404);
  const resolved=await app.inject({method:'POST',url:'/api/v1/assets/resolve',headers,payload:{ids:['a2','a2','staged','missing']}});
  assert.deepEqual(resolved.json().map((a:any)=>a.id),['a2']);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/assets/resolve',headers,payload:{ids:Array(513).fill('a2')}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/assets/query',payload:input})).statusCode,401);
});

test('ingestion persists real audio and video metadata without probing during query', async t => {
  const root=await mkdtemp(join(tmpdir(),'zhilume-metadata-'));
  const app=await createApp({root,token:'metadata-test'});
  t.after(async()=>{await app.close(); if(resolve(root).startsWith(resolve(tmpdir())+sep+'zhilume-metadata-')) await rm(root,{recursive:true,force:true});});
  for (const file of ['interaction-test.wav','interaction-test.mp4']) {
    const response=await app.inject({method:'POST',url:'/api/v1/assets/uploads?filename='+file,headers:{authorization:'Bearer metadata-test','content-type':'application/octet-stream'},payload:await readFile(new URL('./fixtures/'+file,import.meta.url))});
    assert.equal(response.statusCode,201,response.body);
    const asset=response.json(); assert.equal(asset.metadata.status,'ready'); assert.ok(asset.metadata.duration>0);
    if(file.endsWith('mp4')) {assert.ok(asset.metadata.width>0);assert.ok(asset.metadata.height>0);}
  }
});
