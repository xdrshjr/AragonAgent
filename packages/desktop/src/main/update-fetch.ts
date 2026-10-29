/**
 * The network half of the update check, over Electron's `net.fetch`.
 *
 * `net.fetch` rather than Node's `fetch` because it uses Chromium's network stack and so follows
 * the operating system's proxy settings; Node's undici does not, and an update check that works on
 * a developer's machine but silently fails behind a corporate proxy is the common failure here.
 *
 * Redirects are an ERROR, not followed: the feed's address was validated against the build-time
 * host list, and following a redirect would let that check be sidestepped by whoever controls the
 * first hop. A feed must be served from the address it is configured at.
 */

import { net } from 'electron';
import { UpdateFetchError, type FetchText } from './update-service.js';

export const fetchManifestText: FetchText = async (url, { timeoutMs, maxBytes }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await net.fetch(url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new UpdateFetchError('network', `The update feed answered ${response.status}.`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new UpdateFetchError('too_large', 'The update feed is too large.');
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        throw new UpdateFetchError('too_large', 'The update feed is too large.');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    if (error instanceof UpdateFetchError) throw error;
    if (controller.signal.aborted) throw new UpdateFetchError('timeout', 'The update check timed out.');
    throw new UpdateFetchError('network', error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
};
