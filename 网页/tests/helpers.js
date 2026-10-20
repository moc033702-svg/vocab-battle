// 集成测试的共用工具：启动网关（内含真实 C++ 服务器）、模拟玩家、清理进程树。
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 可用 VOCAB_BIN 指定要测试的服务器程序（例如刚编译、尚未覆盖 bin/ 的新版本）
export const BIN = process.env.VOCAB_BIN || path.join(WEB, 'bin', process.platform === 'win32' ? 'vocab_battle.exe' : 'vocab_battle');
export const GATEWAY = path.join(WEB, 'gateway', 'server.js');
export const WORDS = path.join(WEB, 'data', 'words.csv');
export const SKIP = existsSync(BIN) && existsSync(WORDS) ? false : '未构建：缺少 bin/vocab_battle 或 data/words.csv';
export const ALL_TYPES = ['mcq', 'zh2en_mcq', 'en2zh', 'zh2en', 'spell'];

const randPort = () => 20000 + Math.floor(Math.random() * 20000);

// 模拟一名玩家：HTTP 动作 + SSE 视图流。views 与 viewAt（收到的时间戳）一一对应
export class Player {
  constructor(base, name) {
    this.base = base;
    this.name = name;
    this.sid = null;
    this.form = null;
    this.views = [];
    this.viewAt = [];
    this.notices = [];
    this.reader = null;
  }

  async join(level = 'kaoyan', types = ALL_TYPES) {
    this.form = { level, types };
    const res = await fetch(`${this.base}/api/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: this.name, level, types }),
    });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.error), { status: res.status });
    this.sid = body.sid;
    await this.subscribe();
    return this;
  }

  // 用同一个 sid 重新订阅 SSE（模拟页面刷新或网络抖动）
  async subscribe() {
    this.dropStream();
    const res = await fetch(`${this.base}/api/events?sid=${encodeURIComponent(this.sid)}`);
    this.reader = res.body.getReader();
    const reader = this.reader;
    const decoder = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let event = 'message';
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (!data) continue;
            const payload = JSON.parse(data);
            if (event === 'view') { this.views.push(payload); this.viewAt.push(Date.now()); }
            else if (event === 'notice') this.notices.push(payload);
          }
        }
      } catch { /* 连接被关闭 */ }
    })();
    return this;
  }

  // 断开 SSE（不影响服务器上的会话）
  dropStream() {
    this.reader?.cancel().catch(() => {});
    this.reader = null;
  }

  close() {
    this.dropStream();
  }

  // 以同一昵称和同样的难度/题型重新加入（会话已过期后的恢复路径）
  rejoin() {
    return this.join(this.form.level, this.form.types);
  }

  get view() {
    return this.views[this.views.length - 1];
  }

  // 等待满足条件的视图出现（超时抛错）。from 可限定只看某个下标之后的视图
  async waitFor(pred, ms = 10000, label = '', from = 0) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      for (let i = from; i < this.views.length; i++) {
        if (pred(this.views[i])) return this.views[i];
      }
      await sleep(50);
    }
    throw new Error(`${this.name} 等待视图超时：${label}；最近视图 phase=${this.view?.phase}`);
  }

  async act(payload) {
    const res = await fetch(`${this.base}/api/act`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid: this.sid, ...payload }),
    });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body.error), { status: res.status });
    return body;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 轮询直到函数返回真值
export async function until(fn, ms = 10000, label = '') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`等待超时：${label}`);
    await sleep(50);
  }
}

// 启动一套独立的网关 + C++ 服务器，成绩与词库放在临时目录
export async function startFixture({ env = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'vocab-it-'));
  mkdirSync(path.join(root, 'data'));
  copyFileSync(WORDS, path.join(root, 'data', 'words.csv'));
  const port = randPort();
  const tcpPort = randPort();
  const logs = [];
  const child = spawn(process.execPath, [GATEWAY], {
    cwd: WEB,
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', TCP_PORT: String(tcpPort),
      ROOT_DIR: root, BIN, ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  await until(() => logs.join('').includes('网关已启动'), 10000, `网关启动\n${logs.join('')}`);
  return {
    base,
    root,
    tcpPort,
    logs,
    // 读取服务器写出的成绩文件（不存在则返回空数组）
    csv(file) {
      const p = path.join(root, 'data', file);
      return existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim()) : [];
    },
    stop() {
      killTree(child);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// 结束网关及其子进程（含被重启过的 C++）。Windows 上 kill() 不会触发网关清理，因此用 taskkill /T
export function killTree(child) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
  }
}
