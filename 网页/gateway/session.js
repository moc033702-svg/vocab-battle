// 单个玩家：一条 TCP 连接 + 加入握手 + 个人对局状态 + 一条 SSE 推送通道。
// 房间级的状态（进程、名单、分数、视图）在 room.js 里。
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { clientLine, parseServerLine, ProtocolError } from './protocol.js';

export const HANDSHAKE_TIMEOUT_MS = 8000;
// SSE 断开后保留 TCP 的宽限期，期间可凭 sid 恢复；测试可用 GRACE_MS 缩短
export const GRACE_MS = Number(process.env.GRACE_MS) || 120_000;
// 大厅里关掉页面的人很快移出名单（刷新页面通常几秒内就回来）；比赛中仍按 GRACE_MS 保留，便于恢复成绩
export const LOBBY_GRACE_MS = Math.min(GRACE_MS, 15_000);
// 比赛中掉线多久算「退出本局」：够刷新页面回来，又不至于让别人干等一整题
export const ABANDON_MS = Number(process.env.ABANDON_MS) || 5000;
const CONNECT_RETRY_MS = 100;
const CONNECT_TRIES = 50;

let seq = 0;

// 带重试的建连：只在 ECONNREFUSED 时重试（C++ 进程刚启动时端口可能还没开）。
// 不做单独的端口探测连接，因为探测也会在服务器里留下一个空昵称玩家。
function connectWithRetry(port) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const attempt = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.removeAllListeners('error');
        socket.setEncoding('utf8');
        resolve(socket);
      });
      socket.once('error', (err) => {
        socket.destroy();
        if (err.code === 'ECONNREFUSED' && ++tries < CONNECT_TRIES) setTimeout(attempt, CONNECT_RETRY_MS);
        else reject(new ProtocolError('服务器暂不可用，请稍后重试', 'room', 503));
      });
    };
    attempt();
  });
}

export class Session {
  constructor({ socket, form, room }) {
    this.sid = randomBytes(16).toString('hex');   // 浏览器凭它恢复会话，不会暴露给其他玩家
    this.pid = `p${++seq}`;                       // 名单里的展示 id
    this.name = form.name;
    this.level = form.level;
    this.types = form.types;
    this.room = room;
    this.socket = socket;
    this.buffer = '';
    this.onHandshake = null;

    // 身份与准备状态（来自服务器的 ROLE、房主动作）
    this.host = false;
    this.ready = false;

    // 对局状态
    this.stage = 'lobby';       // lobby | quiz | result | final
    this.round = null;          // { no, total }
    this.roundNo = 0;
    this.seconds = 0;           // 本场每题秒数，来自 TIME
    this.question = null;       // 服务器 QUESTION 解析结果
    this.deadline = 0;          // 本题截止时间（毫秒时间戳）
    this.answered = false;
    this.answerLabel = null;    // 玩家提交的内容，用于结果页「你的答案」
    this.timedOut = false;
    this.result = null;         // RESULT 解析结果
    this.finalRank = null;
    this.nudgeUntil = 0;
    this.chatUntil = 0;         // 公屏发言的冷却时间
    // 抢答模式的即时判分（BUZZ_OK / BUZZ_NO）：只对这一题有效
    this.buzzVerdict = null;    // 'correct' | 'wrong' | null
    this.buzzPoints = 0;
    // 比赛中掉线超时：判为本局退出，保留成绩与排行，但不再占用别人的等待
    this.abandoned = false;

    // 连接与推送
    this.res = null;            // 当前的 SSE 响应
    this.graceTimer = null;
    this.deadlineTimer = null;
    this.closed = false;

    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => { /* 连接错误统一由 close 事件处理 */ });
    socket.on('close', () => {
      if (!this.closed) this.room.onSessionLost(this);
    });
  }

  // ---------------- 加入握手 ----------------

  // 与服务器完成 昵称 → 难度 → 题型 的握手，收到 ROLE 才算加入成功
  static open({ port, form, room }) {
    return connectWithRetry(port).then((socket) => {
      const session = new Session({ socket, form, room });
      return session.handshake();
    });
  }

  handshake() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new ProtocolError('加入超时，请重试', 'room', 504)), HANDSHAKE_TIMEOUT_MS);
      const fail = (err) => {
        clearTimeout(timer);
        this.onHandshake = null;
        this.socket.destroy();
        reject(err);
      };
      this.onHandshake = (msg) => {
        switch (msg.type) {
          case 'ask_name': this.send(clientLine.join(this.name)); break;
          case 'ask_level': this.send(clientLine.level(this.level)); break;
          case 'ask_types': this.send(clientLine.types(this.types)); break;
          case 'role':
            clearTimeout(timer);
            this.onHandshake = null;
            this.ready = true;
            this.host = msg.host;
            resolve(this);
            break;
          case 'error': fail(new ProtocolError(msg.text, 'name', 409)); break;
          default: break;   // WELCOME、RECONNECTED、WAIT 等只是提示
        }
      };
    });
  }

  // ---------------- 收发 ----------------

  onData(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).replace(/\r$/, '');
      this.buffer = this.buffer.slice(i + 1);
      if (!line.trim()) continue;
      const msg = parseServerLine(line);
      if (this.onHandshake) this.onHandshake(msg);
      else this.dispatch(msg);
    }
  }

  send(line) {
    if (!this.closed && this.socket.writable) this.socket.write(`${line}\n`);
  }

  // 服务器消息 → 个人状态；需要房间层处理的交给 room
  dispatch(msg) {
    switch (msg.type) {
      case 'role':
        this.host = msg.host;
        this.room.refresh();
        break;
      case 'round': this.onRound(msg); break;
      case 'time': this.seconds = msg.seconds; break;
      case 'question': this.onQuestion(msg); break;
      case 'result': this.onResult(msg); break;
      case 'scores': this.room.onScores(msg.list); break;
      case 'buzz_ok':
        this.buzzVerdict = 'correct';
        this.buzzPoints = msg.points;
        this.room.refresh();
        break;
      case 'buzz_no':
        this.buzzVerdict = 'wrong';
        this.buzzPoints = 0;
        this.room.refresh();
        break;
      case 'final': this.onFinal(msg); break;
      case 'ask_settings': this.room.onAskSettings(this, msg); break;
      case 'info': this.room.onInfo(this, msg.text); break;
      case 'error': this.notify(msg.text, 'bad'); break;
      case 'bye': this.serverClosing = true; break;
      case 'unknown': this.room.log.warn(`未识别的服务器消息：${msg.raw}`); break;
      default: break;   // ASK_START、WAIT、RESTART 等不需要单独处理
    }
  }

  // ---------------- 对局事件 ----------------

  onRound(msg) {
    this.roundNo = msg.no;
    this.round = { no: msg.no, total: msg.total };
    this.question = null;
    this.result = null;
    this.answered = false;
    this.answerLabel = null;
    this.timedOut = false;
    this.buzzVerdict = null;
    this.buzzPoints = 0;
    this.clearDeadline();
    // 不在这里推送：紧接着的 QUESTION 会推送，避免闪一下空白
    this.room.onRound(msg);
  }

  onQuestion(msg) {
    if (msg.type !== 'question') {
      this.room.log.warn(`题面无法解析：${msg.raw}`);
      return;
    }
    this.question = msg;
    this.stage = 'quiz';
    this.answered = false;
    this.buzzVerdict = null;
    this.buzzPoints = 0;
    this.deadline = Date.now() + this.seconds * 1000;
    this.clearDeadline();
    // 网关自己计时：到点还没答就发 TIMEOUT，这样即使玩家的页面已关闭，这一轮也能按时结束
    this.deadlineTimer = setTimeout(() => this.onDeadline(), this.seconds * 1000);
    // 已经算「退出本局」的玩家：每一轮立刻判超时，别让别人等到时间到
    if (this.abandoned) this.forfeitRound();
    this.room.refresh();
  }

  // 本局剩下的轮次一律不参与（已答过则不动）。用于掉线超时后直接把本轮判负
  forfeitRound() {
    this.clearDeadline();
    if (this.stage !== 'quiz' || this.answered) return;
    this.answered = true;
    this.timedOut = true;
    this.send(clientLine.timeout(this.roundNo));
  }

  onDeadline() {
    this.deadlineTimer = null;
    if (this.closed || this.stage !== 'quiz' || this.answered) return;
    this.answered = true;
    this.timedOut = true;
    this.send(clientLine.timeout(this.roundNo));
    this.room.refresh();
  }

  // 结果视图不在这里推送：服务器紧接着会发 SCORES，等榜单到了再统一刷新，避免结果页先空榜再填充
  onResult(msg) {
    this.clearDeadline();
    this.result = msg;
    this.stage = 'result';
    this.answered = true;
  }

  onFinal(msg) {
    this.clearDeadline();
    this.stage = 'final';
    this.room.onFinal(this, msg);
    this.room.refresh();
  }

  clearDeadline() {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }

  // 玩家提交答案。label 用于结果页回显（选择题为「字母：选项文字」）
  submit(answer, label) {
    this.answered = true;
    this.answerLabel = label;
    this.clearDeadline();
    this.send(clientLine.answer(this.roundNo, answer));
    this.room.refresh();
  }

  // ---------------- 推送（SSE） ----------------

  push(event, data) {
    if (this.res && !this.res.writableEnded) {
      this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }

  notify(text, kind = 'info') {
    this.push('notice', { text, kind });
  }

  attach(res) {
    if (this.res && this.res !== res) this.res.end();
    this.res = res;
    clearTimeout(this.graceTimer);
    this.graceTimer = null;
    // 比赛中掉线过又回来了：解除「已退出本局」，从下一题恢复正常
    if (this.abandoned) {
      this.abandoned = false;
      this.room.refresh();
    }
  }

  // SSE 断开：大厅里等一会儿就移出名单；比赛中先给一个短宽限期，超时按「退出本局」处理
  detach(res) {
    if (this.res !== res) return;
    this.res = null;
    clearTimeout(this.graceTimer);
    const idle = this.room.phase === 'lobby' || this.room.phase === 'final';
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (idle) this.room.dropSession(this);
      else this.room.abandon(this);
    }, idle ? LOBBY_GRACE_MS : ABANDON_MS);
  }

  endStream() {
    if (this.res && !this.res.writableEnded) this.res.end();
    this.res = null;
  }

  // ---------------- 关闭 ----------------

  // 主动离开：先告诉服务器 QUIT 再断开，服务器会把这名玩家标记为离线
  close() {
    if (this.closed) return;
    this.send(clientLine.quit());
    this.destroy();
  }

  destroy() {
    this.closed = true;
    this.clearDeadline();
    clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.socket.destroy();
  }
}
