// HTTP 入口：静态页面、JSON 接口、SSE 推送。业务逻辑都在 room.js 与 session.js 里。
//
// 环境变量：
//   PORT=3000        网关监听端口
//   HOST=127.0.0.1   默认只听本机，外网由 HTTPS 反代转发
//   TCP_PORT=18848   C++ 服务器端口
//   TCP_HOST=127.0.0.1  C++ 服务器监听的地址（默认只允许本机连接，不要改成 0.0.0.0）
//   BIN=...          服务器程序路径，默认 bin/vocab_battle(.exe)
//   ROOT_DIR=...     工作目录（服务器在这里读写 data/），测试时指向临时目录
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Room } from './room.js';
import { readStats } from './stats.js';
import { ProtocolError } from './protocol.js';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.env.ROOT_DIR ? path.resolve(process.env.ROOT_DIR) : DEFAULT_ROOT;
const PUBLIC = path.join(DEFAULT_ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const TCP_PORT = Number(process.env.TCP_PORT) || 18848;
const TCP_HOST = process.env.TCP_HOST || '127.0.0.1';
const BIN = process.env.BIN || path.join(ROOT, 'bin', process.platform === 'win32' ? 'vocab_battle.exe' : 'vocab_battle');
const BODY_LIMIT = 4096;
const HEARTBEAT_MS = 15000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
};

const room = new Room({ rootDir: ROOT, bin: BIN, tcpPort: TCP_PORT, tcpHost: TCP_HOST, log: console });

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new ProtocolError('请求内容过长', 'body', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return reject(new ProtocolError('请求格式错误', 'body', 400));
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return reject(new ProtocolError('请求格式错误', 'body', 400));
      }
      resolve(body);
    });
    req.on('error', reject);
  });
}

// 以 SSE 方式推送。会话不存在时也返回一条 closed 视图，前端据此回到加入页
// （EventSource 遇到非 200 会直接放弃重连，所以不能用 404）
function events(req, res, sid) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const session = room.sessionById(sid);
  if (!session) {
    res.write(`event: view\ndata: ${JSON.stringify({ phase: 'closed' })}\n\n`);
    res.end();
    return;
  }
  session.attach(res);
  session.push('view', room.viewFor(session));
  // 公屏历史：重连/刷新后能直接看到之前的聊天
  if (room.chatLog.length) session.push('chat-history', room.chatLog);
  const timer = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(timer);
    session.detach(res);
  });
}

async function api(req, res, url) {
  const { pathname } = url;
  const GET = req.method === 'GET';
  const POST = req.method === 'POST';

  if (pathname === '/api/health' && GET) {
    return sendJson(res, 200, { ok: true, room: room.state, phase: room.phase, sessions: room.sessions.size });
  }
  if (pathname === '/api/stats' && GET) {
    return sendJson(res, 200, await readStats(DATA));
  }
  if (pathname === '/api/join' && POST) {
    const session = await room.join(await readBody(req));
    return sendJson(res, 200, { sid: session.sid });
  }
  if (pathname === '/api/act' && POST) {
    const body = await readBody(req);
    return sendJson(res, 200, room.act(body.sid, body));
  }
  if (pathname === '/api/chat' && POST) {
    const body = await readBody(req);
    return sendJson(res, 200, room.chat(body.sid, body.text));
  }
  if (pathname === '/api/events' && GET) {
    return events(req, res, url.searchParams.get('sid'));
  }
  return sendJson(res, 404, { error: '接口不存在' });
}

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: '路径无效' });
  }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return sendJson(res, 403, { error: '禁止访问' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    sendJson(res, 404, { error: '页面不存在' });
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '方法不允许' });
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    if (err instanceof ProtocolError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
  }
}

const server = http.createServer(handle);

function shutdown() {
  room.stop();
  server.close();
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 300).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

room.start();
server.listen(PORT, HOST, () => {
  console.log(`网关已启动：http://${HOST}:${PORT}（服务器端口 ${TCP_PORT}）`);
});
