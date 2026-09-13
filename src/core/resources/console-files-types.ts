/** Observational project files. Preview digests cover returned bytes, not omitted suffixes. */
export interface ResourceConsoleFileListing {
  projectId: string;
  path: string;
  entries: Array<{ name: string; path: string; kind: 'file' | 'directory'; sizeBytes: number | null }>;
}
export interface ResourceConsoleFilePreview {
  projectId: string;
  path: string;
  text: string;
  sizeBytes: number;
  byteLength: number;
  truncated: boolean;
  digest: string;
}
