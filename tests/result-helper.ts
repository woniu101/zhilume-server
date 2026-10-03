import assert from 'node:assert/strict';

export async function createResultNode(app: any, headers: object, projectId: string, kind: string) {
  const response = await app.inject({method:'PUT',url:`/api/v1/projects/${projectId}/canvas`,headers,payload:{schemaVersion:1,baseRevision:0,nodes:[{id:'result-target',type:'media',position:{x:0,y:0},data:{kind,title:kind}}],edges:[]}});
  assert.equal(response.statusCode,200,response.body);
}

export async function assertNodeResult(app: any, headers: object, projectId: string, job: any, kind: string) {
  const response = await app.inject({method:'GET',url:`/api/v1/projects/${projectId}/node-results`,headers});
  assert.equal(response.statusCode,200,response.body);
  const results = response.json().filter((r:any)=>r.jobId===job.id);
  assert.equal(results.length,1,'a successful Worker job must publish exactly one node result');
  assert.equal(results[0].nodeId,'result-target');
  assert.equal(results[0].output.id,job.outputAssetId);
  assert.equal(results[0].output.kind,kind);
  if(kind==='text') assert.equal(results[0].output.text,job.outputText);
}
