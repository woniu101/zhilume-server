/** Authored condensation of the official H3 writing guides, not an inference adapter.
 * Source: https://github.com/MiniMax-AI/MiniMax-H3/tree/main/skills/h3-prompt-writing
 * Reviewed 2026-09-27. This revision is frozen in submitted jobs.
 */
export const promptRulesRevision = 'zhilume-prompts-2026-09-27.1';
export function h3Rules(context: any) {
  const reference = context?.mode === 'reference';
  return [
    'Rewrite the video prompt in English while preserving dialogue, lyrics and visible text verbatim in their original language. Preserve user intent; invent no reference assets or dialogue.',
    reference ? 'Use these six fields in order: subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music. Explain which properties each reference retains, changes or supplies.' : 'Use these three fields in order: integrated_multimodal_description, overall_soundscape, non_diegetic_music. Prepend keyframe alignment when the mode has first and/or last frames; describe a continuous transition between the provided anchors.',
    'Keep <Picture N>, <Video N>, <Audio N> labels consistent. Use sequential [Shot N] sections; later cuts have increasing times within the requested duration. Use concrete visual and audible events, camera motion and subject continuity. Preserve exact quoted scene text.',
    'Place original dialogue inside <d> with its language label, keep speaker identifiers stable. Separate environmental sound from background music. Use N/A for background music when none is requested; do not add speech.',
    'Reference images are only visible to you when attached to this request. If absent, preserve their declared roles without inventing their contents.',
    'Task constraints: ' + JSON.stringify(context || {}),
    'Return only the suggested prompt. This is a suggestion; no generation is performed by this request.',
  ].join('\n');
}
