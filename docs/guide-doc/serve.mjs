#!/usr/bin/env node
/**
 * 本地预览静态服务器（spec §7.2 / §10.2）。零依赖，只用 node:http / node:fs / node:path。
 * 不做 SPA 回退、gzip 协商与端口重试：悄悄换端口会把排障变成考古，所以占用一律报错（§7.2）。
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const USAGE = `用法: node docs/guide-doc/serve.mjs [--port 4173] [--host 127.0.0.1] [--dir docs/guide-doc/dist]
选项:
  --port <n>    端口，默认 4173
  --host <h>    绑定地址，默认 127.0.0.1
  --dir <path>  静态根目录，默认 docs/guide-doc/dist
  -h, --help    显示本帮助
Ctrl+C 停止。`;
/** 扩展名 → MIME（§7.2 的清单，未列出的一律 application/octet-stream）。 */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};
const PLAIN = 'text/plain; charset=utf-8';
/** @returns {{port: number, host: string, dir: string} | {help: true} | {error: string}} */
function parseArgs(argv) {
  const options = { port: 4173, host: '127.0.0.1', dir: 'docs/guide-doc/dist' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '-h' || flag === '--help') return { help: true };
    if (flag !== '--port' && flag !== '--host' && flag !== '--dir') {
      return { error: `未知参数: ${flag}` };
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return { error: `参数 ${flag} 缺少取值` };
    i += 1;
    if (flag === '--host') options.host = value;
    else if (flag === '--dir') options.dir = value;
    else {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { error: `--port 需要 1–65535 的整数，收到 ${value}` };
      }
      options.port = port;
    }
  }
  return options;
}
/** §10.2 的缓存策略；页面路由没有扩展名，按路径尾斜杠判定。 */
function cacheControl(urlPath, file) {
  if (urlPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (urlPath === '/search-index.json') return 'public, max-age=600';
  if (urlPath === '/_meta.json' || urlPath === '/sitemap.xml') return 'public, max-age=60';
  const isPage = extname(file) === '.html' || urlPath.endsWith('/');
  return isPage ? 'public, max-age=600, must-revalidate' : 'public, max-age=600';
}
/** 规范化后按分隔符判断是否仍在根内（越界必须 403，不能靠字符串 includes）。 */
function insideRoot(rootDir, target) {
  return target === rootDir || target.startsWith(rootDir.endsWith(sep) ? rootDir : rootDir + sep);
}
/** 发一段纯文本响应。 */
function send(res, status, headers, body = '') {
  const payload = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'Content-Type': PLAIN, 'Content-Length': payload.length, 'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}
/** 发磁盘文件：Content-Length 取自 stat（不整读进内存），HEAD 只回头。 */
async function sendFile(res, file, status, cache, isHead) {
  const info = await stat(file);
  res.writeHead(status, {
    'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': info.size, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff',
  });
  if (isHead) return void res.end();
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}
/** 未命中：优先 404/index.html，缺失时退回纯文本，状态始终 404。 */
async function sendMissing(rootDir, res, isHead, cache) {
  try {
    await sendFile(res, resolve(rootDir, '404/index.html'), 404, cache, isHead);
  } catch {
    send(res, 404, { 'Cache-Control': cache }, '404 Not Found\n');
  }
}
/** 处理一个请求（GET/HEAD only；目录 → index.html；无尾斜杠的目录 → 301）。 */
async function handle(rootDir, req, res) {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    return void send(res, 405, { Allow: 'GET, HEAD' }, '405 Method Not Allowed\n');
  }
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
  } catch {
    return void send(res, 400, {}, '400 Bad Request\n');
  }
  const target = resolve(rootDir, `.${urlPath}`);
  if (!insideRoot(rootDir, target)) return void send(res, 403, {}, '403 Forbidden\n');
  const isHead = method === 'HEAD';
  const cache = cacheControl(urlPath, target);
  try {
    const info = await stat(target);
    if (!info.isDirectory()) await sendFile(res, target, 200, cache, isHead);
    else if (!urlPath.endsWith('/')) {
      send(res, 301, { Location: `${urlPath}/`, 'Cache-Control': cache }, '301 Moved Permanently\n');
    } else await sendFile(res, resolve(target, 'index.html'), 200, cache, isHead);
  } catch {
    await sendMissing(rootDir, res, isHead, cache);
  }
}
/**
 * 创建预览服务器（导出以便测试直接调用，不绑定端口）。
 *
 * @param {string} rootDir 已解析的静态根目录
 * @returns {import('node:http').Server} HTTP 服务器
 */
export function createPreviewServer(rootDir) {
  return createServer((req, res) => {
    handle(rootDir, req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else send(res, 500, {}, '500 Internal Server Error\n');
    });
  });
}
/** CLI 入口：EADDRINUSE 只报错退出，绝不静默换端口。 */
function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if ('help' in parsed) {
    console.log(USAGE);
    return;
  }
  if ('error' in parsed) {
    console.error(`${parsed.error}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  const rootDir = resolve(process.cwd(), parsed.dir);
  const server = createPreviewServer(rootDir);
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`${parsed.port} 已被占用，用 --port ${parsed.port + 1}`);
      process.exit(1);
      return;
    }
    throw err;
  });
  server.listen(parsed.port, parsed.host, () => {
    const host = parsed.host === '0.0.0.0' || parsed.host === '::' ? 'localhost' : parsed.host;
    console.log(`静态根目录: ${rootDir}`);
    console.log(`预览地址:   http://${host}:${parsed.port}/`);
    console.log('Ctrl+C 停止');
  });
}
if (process.argv[1] && process.argv[1].endsWith('serve.mjs')) main();
