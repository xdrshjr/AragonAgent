export const INSECURE_TLS_WARNING: string;

export function installInsecureTlsWarningFilter(
  target?: NodeJS.Process,
): () => void;
