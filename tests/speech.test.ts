import { fingerprint } from '../src/execution.js';
function signed(p: any) { const { profileId, ...spec } = p; spec.identity ||= { revision: 'fixture-v1', quantization: 'fp32', artifacts: { model: 'revision:fixture-v1' } }; return { ...spec, profileId: fingerprint(spec) }; }
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpeechProfiles, validateSpeechInput, validateSpeechDraft, supportsSpeechJob, speechModels } from '../src/speech-operations.js';
const model = speechModels[0];
const profile = signed({ modelId: model.id, profileId: 'a'.repeat(64), workflowRevision: model.workflowRevision, upstreamRevision: model.upstreamRevision,
  languages: ['ZH'], emotionModes: ['follow','reference','vector'], maxTextCharacters: 1000, validation: 'unverified' });
const workers = [{ connected: true, lastHeartbeat: Date.now(), speechProfiles: [profile] }];
const draft = { modelId: model.id, profileId: '', text: '', language: 'ZH', speed: 1, speaker: { assetId: '', start: 0, end: 10 }, emotionReference: { assetId: '', start: 0, end: 10 }, emotionMode: 'follow', emotionAlpha: .6, emotionText: '', emotionVector: Array(8).fill(0) };
test('speech separates draft and runtime limits, preserves roles and routes only matching profiles', () => {
  assert.doesNotThrow(() => validateSpeechDraft(draft));
  assert.throws(() => validateSpeechDraft({ ...draft, speed: NaN }));
  assert.throws(() => validateSpeechProfiles([{ ...profile, upstreamRevision: 'unknown' }]));
  assert.equal(validateSpeechProfiles([profile]).length, 1);
  const input = { ...draft, text: '你好', profileId: profile.profileId, workflowRevision: profile.workflowRevision, speaker: { assetId: 'voice', start: 2, end: 8 }, emotionMode: 'reference', emotionReference: { assetId: 'emotion', start: 0, end: 4 } };
  const lookup = (id: string) => ({ id, kind: 'audio', size: 1000 });
  const parsed = validateSpeechInput(input, workers, lookup);
  assert.deepEqual(parsed.referenceAssetIds, ['voice','emotion']);
  assert.equal(parsed.speaker.start, 2);
  assert.throws(() => validateSpeechInput({ ...input, speed: 0 }, workers, lookup));
  assert.throws(() => validateSpeechInput({ ...input, emotionMode: 'text' }, workers, lookup));
  assert.throws(() => validateSpeechInput(input, workers, id => ({...lookup(id),kind:'video'})));
  assert.doesNotThrow(() => validateSpeechInput(input, [{ ...workers[0], connected:false }], lookup));
  assert.equal(supportsSpeechJob(workers[0], {operation:'audio.speech.v1',input:parsed}), true);
  assert.equal(supportsSpeechJob(workers[0], {operation:'audio.speech.v1',input:{...parsed,profileId:'b'.repeat(64)}}), false);
});
