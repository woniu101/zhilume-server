import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/server.js';

test('server identity survives restart; renewable sessions rotate once and revoke access',async()=>{
  const root=await mkdtemp(join(tmpdir(),'zhilume-session-'));
  let app=await createApp({root,token:'fixture-secret'});
  try {
    const identity=(await app.inject({method:'GET',url:'/api/v1/system'})).json();
    assert.equal(identity.protocolVersion,'3.1');assert.ok(identity.serverId);
    const response=await app.inject({method:'POST',url:'/api/v1/session',payload:{token:'fixture-secret'}});
    assert.equal(response.statusCode,200);const first=response.json();
    const status=(token:string)=>app.inject({method:'GET',url:'/api/v1/session/status',headers:{authorization:'Bearer '+token}});
    assert.equal((await status(first.token)).statusCode,200);
    await app.close();app=await createApp({root,token:'fixture-secret'});
    assert.equal((await app.inject({method:'GET',url:'/api/v1/system'})).json().serverId,identity.serverId);
    assert.equal((await status(first.token)).statusCode,200);
    const renew=()=>app.inject({method:'POST',url:'/api/v1/session/renew',payload:{refreshToken:first.refreshToken}});
    const results=await Promise.all([renew(),renew()]);assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,401]);
    const next=results.find(r=>r.statusCode===200)!.json();assert.notEqual(next.refreshToken,first.refreshToken);
    assert.equal((await status(first.token)).statusCode,401);assert.equal((await status(next.token)).statusCode,200);
    await app.inject({method:'POST',url:'/api/v1/session/revoke',payload:{refreshToken:next.refreshToken}});
    assert.equal((await status(next.token)).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/v1/session/renew',payload:{refreshToken:next.refreshToken}})).statusCode,401);
  } finally {await app.close();await rm(root,{recursive:true,force:true});}
});
