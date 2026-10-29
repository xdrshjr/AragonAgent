export interface ManifestArtifact {
  file: string;
  platform: 'win' | 'mac' | 'linux' | null;
  url: string;
  sha256: string;
  size: number;
}
export interface GeneratedManifest {
  version: string;
  releasedAt: string;
  notesUrl?: string;
  downloadUrl: string;
  artifacts: ManifestArtifact[];
}
export function platformOf(fileName: string): 'win' | 'mac' | 'linux' | null;
export function sha256File(path: string): Promise<string>;
export function findArtifacts(dir: string): string[];
export function assertHttpsBase(baseUrl: string): URL;
export function buildManifest(input: {
  version: string;
  baseUrl: string;
  artifacts: ReadonlyArray<{ name: string; sha256: string; size: number }>;
  notesUrl?: string;
  releasedAt?: string;
  downloadUrl?: string;
}): GeneratedManifest;
export function readBack(
  manifest: GeneratedManifest,
  baseUrl: string,
  parse: (text: string, config: { allowedHosts: string[]; allowLoopbackHttp: boolean }) => { version: string; downloadUrl: string; notesUrl?: string } | null,
): { version: string; downloadUrl: string; notesUrl?: string };
