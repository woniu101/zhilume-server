import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateVideoProfiles, validateVideoInput, validateVideoDraft, supportsVideoJob, videoModels } from '../src/video-operations.js';
const model = videoModels[1];
const profile = { modelId:model.id, profileId:'a'.repeat(64), workflowRevision:model.workflowRevision, modes:model.modes,
  sizes:[[512,288]], frames:[124,243], fps:24, referenceLimits:{image:9,video:3,audio:3}, defaultSteps:20,maxSteps:50,validation:'unverified' };
const workers = [{connected:true,lastHeartbeat:Date.now(),videoProfiles:[profile]}];
const assets:any = { image:{id:'image',kind:'image',size:100}, video:{id:'video',kind:'video',size:100}, audio:{id:'audio',kind:'audio',size:100} };
const input = { ...profile, mode:'reference',prompt:'Use <Video 1> motion and <Audio 1> sound',width:512,height:288,frames:124,steps:20,seed:0,includeAudio:true,
  references:[{role:'video',assetId:'video',start:0,frames:56},{role:'audio',assetId:'audio',start:1,frames:73},{role:'video',assetId:'video',start:3,frames:56}] };
test('H3 reference roles, exact frame grid, limits, online routing and archival parameters', () => {
  assert.equal(validateVideoProfiles([profile]).length,1);
  assert.throws(()=>validateVideoProfiles([{...profile,frames:[120]}]));
  const value = validateVideoInput(input,workers,id=>assets[id]);
  assert.deepEqual(value.referenceAssetIds,['video','audio']);
  assert.equal(value.references.length,3); assert.equal(value.fps,24);
  assert.throws(()=>validateVideoInput({...input,references:[null]},workers,id=>assets[id]));
  assert.throws(()=>validateVideoInput({...input,references:[{role:'first',assetId:'image'}]},workers,id=>assets[id]));
  assert.throws(()=>validateVideoInput({...input,frames:120},workers,id=>assets[id]));
  assert.throws(()=>validateVideoInput({...input,references:[{role:'video',assetId:'image',start:0,frames:56}]},workers,id=>assets[id]));
  assert.throws(()=>validateVideoInput({...input,frames:243,references:[0,1].map(()=>({role:'video',assetId:'video',start:0,frames:243}))},workers,id=>assets[id]));
  assert.throws(()=>validateVideoInput(input,[{...workers[0],connected:false}],id=>assets[id]));
  assert.equal(supportsVideoJob(workers[0],{operation:'video.generate.v1',input:value}),true);
  assert.equal(supportsVideoJob(workers[0],{operation:'video.generate.v1',input:{...value,profileId:'b'.repeat(64)}}),false);
});
test('H3 draft remains editable without an online profile and rejects invalid saved values',()=>{
  const d={...input,profileId:'',firstFrameId:'',lastFrameId:'',prompt:''};
  assert.doesNotThrow(()=>validateVideoDraft(d));
  assert.doesNotThrow(()=>validateVideoDraft({...d,references:Array(13).fill({role:'image',assetId:'image',start:0,frames:56})}));
  assert.throws(()=>validateVideoInput({...input,references:Array(13).fill({role:'image',assetId:'image'})},workers,id=>assets[id]));
  assert.throws(()=>validateVideoDraft({...d,frames:120}));
  assert.throws(()=>validateVideoDraft({...d,steps:1.5}));
});
