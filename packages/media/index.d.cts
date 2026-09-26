declare namespace media {
  type Operation = 'media.video.trim.v1' | 'media.audio.extract.v1';
  type Parameters = { start: number; end: number };
  type Progress = { phase: 'validating' | 'processing'; progress: number | null };
  const OPERATIONS: readonly Operation[];
  const MAX_BYTES: number;
  class MediaError extends Error { code: string; constructor(code: string, message: string); }
  function validate(operation: string, parameters: unknown): Parameters;
  function format(operation: string): { filename: string; mimeType: string; kind: string };
  function argumentsFor(operation: string, parameters: Parameters, input: string, output: string): string[];
  function processFile(options: { executable: string; input: string; output: string; operation: string; parameters: Parameters; signal?: AbortSignal; onProgress?: (value: Progress) => void }): Promise<{ filename: string; mimeType: string; kind: string; size: number; path: string }>;
}
export = media;
