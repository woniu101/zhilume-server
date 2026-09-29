import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { providerRequest, providerContent, boundedProviderJson } from '../src/language-protocol.js';

for (const protocol of ['chat-completions', 'responses', 'anthropic-messages']) {
  test(`${protocol}: discover, configure two models, generate and archive without exposing credentials`, {timeout:30000}, async t => {
    const root = await mkdtemp(join(tmpdir(), 'zhilume-protocol-'));
    const app = await createApp({root, token:'owner', tickMs:20});
    const requests:any[]=[];
    const provider = createServer(async (req,res) => {
      requests.push({url:req.url, headers:req.headers});
      if (req.method === 'GET') {res.end(JSON.stringify({data:[{id:'first'}, {id:'second'}, null]})); return;}
      let raw=''; for await(const chunk of req) raw+=chunk;
      requests.at(-1).body=JSON.parse(raw);
      res.end(JSON.stringify(protocol==='responses'
        ? {status:'completed',output:[{type:'message',status:'completed',content:[{type:'output_text',text:'result'}]}]}
        : protocol==='anthropic-messages'
          ? {stop_reason:'end_turn',content:[{type:'text',text:'result'}]}
          : {choices:[{finish_reason:'stop',message:{content:'result'}}]}));
    });
    provider.listen(0,'127.0.0.1'); await once(provider,'listening');
    t.after(async()=>{await app.close();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
    const request=(path:string, body?:any, token='owner')=>app.inject({method:body?'POST':'GET',url:'/api/v1'+path,headers:{authorization:'Bearer '+token},payload:body});
    const call=async(path:string, body?:any)=>{const r=await request(path,body);assert.ok(r.statusCode<300,r.body);return r.json();};
    const config={name:'Test',baseUrl:`http://127.0.0.1:${(provider.address() as any).port}/v1`,protocol,apiKey:'test-private-key',models:[{model:'first',capabilities:['text']},{model:'second',capabilities:['text']}],defaults:{text:'second'}};
    assert.equal((await request('/language/providers/discover',config,'wrong')).statusCode,401);
    const list=await call('/language/providers/discover',config);
    assert.deepEqual(list.models.map((m:any)=>m.id),['first','second']); assert.ok(list.elapsedMs>=0);
    const saved=await call('/language/providers',config);
    const updated=await call('/language/providers',{...saved,apiKey:'',name:'Renamed'});
    assert.equal(updated.models.length,2);assert.equal(updated.defaults.text,'second');
    assert.ok(!JSON.stringify(updated).includes(config.apiKey));
    await call('/language/providers/discover',{...saved,apiKey:''});
    const before=requests.length;
    const changed={...saved,baseUrl:config.baseUrl+'/other',apiKey:''};
    assert.equal((await request('/language/providers/discover',changed)).statusCode,400);
    assert.equal((await request('/language/providers',changed)).statusCode,400);
    assert.equal(requests.length,before);
    const project=await call('/projects',{name:'Protocol test'});
    const model=(await call('/language/models')).find((m:any)=>m.model==='second');
    const job=await call('/jobs',{requestId:crypto.randomUUID(),projectId:project.id,operation:'text.generate.v1',input:{profileId:model.profileId,text:'Original'}});
    let result:any;
    for(let i=0;i<100;i++){result=await call('/jobs/'+job.id);if(['succeeded','failed'].includes(result.status))break;await new Promise(r=>setTimeout(r,25));}
    assert.equal(result.status,'succeeded',JSON.stringify(result)); assert.equal(result.outputText,'result');
    const asset=await call('/assets/'+result.outputAssetId); assert.equal(asset.kind,'text');
    const sent=requests.at(-1);
    assert.equal(sent.body.model,'second');
    assert.equal(sent.url, '/v1/'+({'chat-completions':'chat/completions',responses:'responses','anthropic-messages':'messages'}[protocol]));
    assert.equal(protocol==='anthropic-messages'?sent.headers['x-api-key']:sent.headers.authorization,protocol==='anthropic-messages'?'test-private-key':'Bearer test-private-key');
    assert.ok(!JSON.stringify(result).includes(config.apiKey));
  });
}

test('native formats preserve images and schema; reject truncated or refused output and bound errors',async()=>{
  const schema={type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false};
  const input={text:'Inspect',systemPrompt:'Return JSON',schema};
  const images=[{mime:'image/png',data:'YWJj'}];
  const responses=providerRequest({protocol:'responses',model:'m',maxOutputTokens:100},input,images).body as any;
  assert.equal(responses.input[0].content[1].image_url,'data:image/png;base64,YWJj');
  assert.deepEqual(responses.text.format.schema,schema);assert.equal(responses.store,false);
  const messages=providerRequest({protocol:'anthropic-messages',model:'m',maxOutputTokens:100},input,images).body as any;
  assert.deepEqual(messages.messages[0].content[1].source,{type:'base64',media_type:'image/png',data:'YWJj'});
  assert.deepEqual(messages.output_config.format.schema,schema);
  assert.throws(()=>providerContent('responses',{status:'incomplete',output:[]}));
  assert.throws(()=>providerContent('responses',{status:'completed',output:[{type:'message',status:'completed',content:[{type:'refusal'}]}]}));
  assert.throws(()=>providerContent('anthropic-messages',{stop_reason:'max_tokens',content:[]}));
  await assert.rejects(()=>boundedProviderJson(new Response('secret-key',{status:403})),e=>e instanceof Error&&!e.message.includes('secret-key'));
  await assert.rejects(()=>boundedProviderJson(new Response('x'.repeat(100)),10));
});
