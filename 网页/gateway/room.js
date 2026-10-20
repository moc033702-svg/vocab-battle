// 房间：一个 C++ 服务器进程 + 网关侧的全部玩家会话。
// C++ 不广播名单和他人的分数，所以名单、分数统计、视图都在这里算。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  clientLine, validateName, validateLevel, validateTypes, validateSettings, validateMode,
  sanitizeAnswer, ProtocolError, DEFAULT_SETTINGS, LEVEL_NAMES, TYPE_NAMES,
} from './protocol.js';
import { Session } from './session.js';

export const MAX_SESSIONS = 100;
export const NUDGE_COOLDOWN_MS = 30_000;
const RESTART_DELAY_MS = 1000;
// 房间公屏：只保留最近这些条，重启/开新局不影响（整房销毁时清空）
const CHAT_KEEP = 60;
const CHAT_MAX_LEN = 120;
const CHAT_COOLDOWN_MS = 1200;

export class Room {
  constructor({ rootDir, bin, tcpPort, tcpHost = '127.0.0.1', log = console }) {
    this.rootDir = rootDir;
    this.bin = bin;
    this.tcpPort = tcpPort;
    this.tcpHost = tcpHost;      // 服务器监听的地址：默认只允许本机（网关）连接
    this.log = log;

    this.sessions = new Map();   // sid -> Session
    this.proc = null;
    this.state = 'stopped';      // stopped | running | missing（找不到服务器程序）
    this.stopping = false;
    this.restartTimer = null;

    // 对局状态：lobby 等待开始 → starting（已发 START，等 SETTINGS）→ playing → final（终局，等房主再来一局）
    this.phase = 'lobby';
    this.settings = { ...DEFAULT_SETTINGS };
    this.pendingSettings = null;
    this.closing = false;        // 房主已发 EXIT，等进程退出

    // 分数统计（按昵称）：每轮结束时从 SCORES 更新一次
    this.roundNo = 0;
    this.scoredNo = 0;
    this.scores = new Map();     // name -> { score, delta, combo, maxCombo, correct, total }
    this.scoreOrder = [];        // 最近一次 SCORES 的顺序
    this.finalList = null;       // FINAL 的名单（已去掉空名字的幽灵项）

    // 房间公屏（内存里，不落盘）
    this.chatLog = [];
    this.chatSeq = 0;
  }

  // ---------------- 服务器进程 ----------------

  start() {
    this.stopping = false;
    if (!existsSync(this.bin)) {
      this.state = 'missing';
      this.log.error(`找不到服务器程序：${this.bin}。请先运行构建脚本。`);
      return;
    }
    // 服务器把词库与成绩写到相对于当前目录的 data/，所以工作目录必须是网页根目录。
    // 轮数与秒数只是启动时的默认值，房主开赛时会用 SETTINGS 覆盖；最后一个参数是监听地址（P3）
    const proc = spawn(this.bin, ['server', String(this.tcpPort), '10', '20', this.tcpHost], {
      cwd: this.rootDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.state = 'running';
    this.relay(proc.stdout);
    this.relay(proc.stderr);
    proc.on('error', (err) => this.log.error(`服务器进程启动失败：${err.message}`));
    proc.on('exit', (code) => this.onProcessExit(proc, code));
    this.log.log(`服务器进程已启动（端口 ${this.tcpPort}）`);
  }

  relay(stream) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        this.log.log(`[服务器] ${buf.slice(0, i).replace(/\r$/, '')}`);
        buf = buf.slice(i + 1);
      }
    });
  }

  // 进程退出（房主 EXIT 或崩溃）：所有会话回到加入页，然后自动拉起新进程
  onProcessExit(proc, code) {
    if (proc !== this.proc) return;
    this.proc = null;
    this.log.log(`服务器进程已退出（代码 ${code}）`);
    this.teardown();
    if (!this.stopping) {
      this.restartTimer = setTimeout(() => this.start(), RESTART_DELAY_MS);
    }
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.proc) this.proc.kill();
    this.teardown();
  }

  teardown() {
    const list = [...this.sessions.values()];
    this.sessions.clear();
    for (const s of list) {
      s.closed = true;
      s.push('view', { phase: 'closed' });
      s.endStream();
      s.destroy();
    }
    this.phase = 'lobby';
    this.pendingSettings = null;
    this.closing = false;
    this.roundNo = 0;
    this.chatLog = [];
    this.resetStats();
  }

  // ---------------- 加入与离开 ----------------

  async join(form) {
    if (this.state === 'missing') throw new ProtocolError('服务器程序未找到，请先构建', 'room', 503);
    if (this.state !== 'running' || this.closing) throw new ProtocolError('房间正在重启，请稍后再试', 'room', 503);
    if (this.sessions.size >= MAX_SESSIONS) throw new ProtocolError('房间人数已满', 'room', 503);

    const clean = {
      name: validateName(form.name),
      level: validateLevel(form.level),
      types: validateTypes(form.types),
    };
    const session = await Session.open({ port: this.tcpPort, form: clean, room: this });
    // 握手期间房间可能已被关闭/重启
    if (this.state !== 'running' || this.closing) {
      session.destroy();
      throw new ProtocolError('房间正在重启，请稍后再试', 'room', 503);
    }
    this.sessions.set(session.sid, session);
    this.refresh();
    return session;
  }

  sessionById(sid) {
    return this.sessions.get(sid) || null;
  }

  // 玩家主动离开或 SSE 宽限期过期
  dropSession(session) {
    if (!this.sessions.has(session.sid)) return;
    this.sessions.delete(session.sid);
    session.close();
    session.endStream();
    this.refresh();
  }

  // 比赛中掉线超过 ABANDON_MS：判为本局退出。
  // 不删会话（成绩与排行留着），但这一轮以及后面的每一轮都直接算超时，别人不用再等他。
  abandon(session) {
    if (!this.sessions.has(session.sid) || session.abandoned) return;
    session.abandoned = true;
    session.forfeitRound();
    this.refresh();
  }

  // TCP 被服务器断开（进程退出、被踢等）。房主关闭房间时，服务器先断开连接、进程稍后才退出，
  // 这时由 teardown（进程真正退出后）统一通知所有人，不能提前让会话消失，否则重新加入会在进程未退出时被拒绝
  onSessionLost(session) {
    if (this.closing || !this.sessions.has(session.sid)) return;
    this.sessions.delete(session.sid);
    session.closed = true;
    session.push('view', { phase: 'closed' });
    session.endStream();
    this.refresh();
  }

  // ---------------- 玩家动作 ----------------

  act(sid, payload) {
    const session = this.sessionById(sid);
    if (!session) throw new ProtocolError('会话已失效，请重新加入', 'sid', 404);
    switch (payload.type) {
      case 'start':
      case 'restart':
        return this.startGame(session, payload);
      case 'answer':
        return this.submitAnswer(session, payload);
      case 'nudge':
        return this.nudge(session);
      case 'exit':
        return this.exitRoom(session);
      case 'leave':
        this.dropSession(session);
        return {};
      case 'buzz':
        throw new ProtocolError('抢答无需单独按铃，题目出现后直接提交答案即可', 'type', 400);
      default:
        throw new ProtocolError('未知的操作', 'type', 400);
    }
  }

  canStart() {
    const list = [...this.sessions.values()].filter((s) => !s.abandoned);
    return list.length >= 2 && list.every((s) => s.ready);
  }

  startGame(session, payload) {
    if (!session.host) throw new ProtocolError('只有房主可以开始比赛', 'type', 403);
    if (this.phase !== 'lobby' && this.phase !== 'final') throw new ProtocolError('比赛进行中', 'type', 409);
    if (!this.canStart()) throw new ProtocolError('至少需要 2 名玩家，且全部就绪后才能开始', 'type', 409);
    this.pendingSettings = validateSettings(payload.settings, this.settings);
    this.phase = 'starting';
    session.send(clientLine.start(validateMode(this.pendingSettings.mode)));
    this.refresh();
    return {};
  }

  // 服务器要求房主提供参数（ASK_SETTINGS）：用刚才提交的参数回答
  onAskSettings(session) {
    if (!session.host || this.phase !== 'starting' || !this.pendingSettings) return;
    const settings = this.pendingSettings;
    this.pendingSettings = null;
    this.settings = settings;
    session.send(clientLine.settings(settings));
    this.refresh();
  }

  submitAnswer(session, payload) {
    if (session.stage !== 'quiz' || !session.question) throw new ProtocolError('本题尚未开始或已结束', 'answer', 409);
    if (session.answered) throw new ProtocolError('本题已作答', 'answer', 409);
    if (Date.now() >= session.deadline) throw new ProtocolError('本题已超时', 'answer', 409);

    const q = session.question;
    let answer = sanitizeAnswer(payload.answer);
    let label = answer;
    if (q.options) {
      // 选择题只接受 A–D；发给服务器的同样是字母，服务器也认 1–4
      const key = answer.toUpperCase();
      const opt = q.options.find((o) => o.key === key);
      if (!opt) throw new ProtocolError('请选择 A–D 中的一个选项', 'answer', 400);
      answer = key;
      label = `${opt.key}：${opt.text}`;
    } else if (!answer) {
      throw new ProtocolError('请输入答案', 'answer', 400);
    }
    session.submit(answer, label);
    return {};
  }

  nudge(session) {
    if (session.host) throw new ProtocolError('你是房主，无需催促', 'type', 400);
    if (this.phase !== 'lobby') throw new ProtocolError('比赛进行中，无法催促', 'type', 409);
    const now = Date.now();
    if (now < session.nudgeUntil) throw new ProtocolError('催促太频繁，请稍后再试', 'type', 429);
    session.nudgeUntil = now + NUDGE_COOLDOWN_MS;
    session.send(clientLine.nudge());
    return {};
  }

  // 房间公屏：所有人可见。答题进行中不允许发言——题目还没结束，发消息等于泄题。
  chat(sid, raw) {
    const session = this.sessionById(sid);
    if (!session) throw new ProtocolError('会话已失效，请重新加入', 'sid', 404);
    if (session.stage === 'quiz') throw new ProtocolError('答题进行中，暂不能发言', 'chat', 409);
    const text = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
    if (!text) throw new ProtocolError('不能发送空消息', 'chat', 400);
    if ([...text].length > CHAT_MAX_LEN) throw new ProtocolError(`消息最多 ${CHAT_MAX_LEN} 个字符`, 'chat', 400);
    const now = Date.now();
    if (now < session.chatUntil) throw new ProtocolError('发得太快了，稍等一下', 'chat', 429);
    session.chatUntil = now + CHAT_COOLDOWN_MS;

    const msg = { id: ++this.chatSeq, name: session.name, host: session.host, text, at: now };
    this.chatLog.push(msg);
    if (this.chatLog.length > CHAT_KEEP) this.chatLog.splice(0, this.chatLog.length - CHAT_KEEP);
    for (const s of this.sessions.values()) s.push('chat', msg);
    return { ok: true };
  }

  exitRoom(session) {
    if (!session.host) throw new ProtocolError('只有房主可以关闭房间', 'type', 403);
    if (this.phase === 'starting' || this.phase === 'playing') throw new ProtocolError('比赛进行中，无法关闭房间', 'type', 409);
    this.closing = true;
    session.send(clientLine.exit());
    return {};
  }

  // ---------------- 服务器消息 → 房间状态 ----------------

  onRound(msg) {
    this.roundNo = msg.no;
    this.phase = 'playing';
    if (msg.no === 1) this.resetStats();   // 新的一局从第 1 轮开始，清掉上一局的统计
  }

  onScores(list) {
    const named = list.filter((e) => e.name);   // 空名字是幽灵玩家，不计入
    // 每个玩家都会收到同一份 SCORES，只统计一次；但每次都要刷新，让各自的结果页拿到榜单
    if (this.scoredNo !== this.roundNo) {
      this.scoredNo = this.roundNo;
      for (const e of named) {
        const t = this.scores.get(e.name) || { score: 0, delta: 0, combo: 0, maxCombo: 0, correct: 0, total: 0 };
        // 答对一定得分（基础分 ≥ 1），答错与超时都是 0 分；因此增量 > 0 即为答对
        t.delta = e.score - t.score;
        t.total += 1;
        if (t.delta > 0) {
          t.correct += 1;
          t.combo += 1;
          t.maxCombo = Math.max(t.maxCombo, t.combo);
        } else {
          t.combo = 0;
        }
        t.score = e.score;
        this.scores.set(e.name, t);
      }
      this.scoreOrder = named.map((e) => e.name);
    }
    this.refresh();
  }

  onFinal(session, msg) {
    if (!this.finalList) this.finalList = msg.list.filter((e) => e.name);
    this.phase = 'final';
    // 中途退出的客人在本局结束后清出房间，免得「再来一局」时名单里挂着 0 分的幽灵
    for (const s of [...this.sessions.values()]) {
      if (s.abandoned && !s.host) this.dropSession(s);
    }
  }

  onInfo(session, text) {
    // 开局被服务器拒绝（人数或就绪不足）：回到等待状态，需要重新推送视图
    if (session.host && this.phase === 'starting' && text.startsWith('至少需要')) {
      this.phase = 'lobby';
      this.pendingSettings = null;
      session.notify(text, 'info');
      this.refresh();
      return;
    }
    // 其它提示（如催促）只弹一条通知，不推送整屏视图，否则房主页面会整屏重绘闪烁。
    // 催促单独标一个 kind：房主页面要把它做成醒目的横幅 + 提示音
    session.notify(text, text.includes('催促') ? 'nudge' : 'info');
  }


  // 只清统计，不动 roundNo（ROUND 消息已经更新过它）
  resetStats() {
    this.scoredNo = 0;
    this.scores.clear();
    this.scoreOrder = [];
    this.finalList = null;
  }

  // ---------------- 视图（前端按 phase 渲染，结构见 public/js/mock.js 文件头） ----------------

  refresh() {
    for (const s of this.sessions.values()) {
      if (s.res) s.push('view', this.viewFor(s));
    }
  }

  viewFor(session) {
    const me = {
      id: session.pid,
      name: session.name,
      host: session.host,
      ready: session.ready,
      score: this.scoreOf(session.name),
      combo: this.comboOf(session.name),
    };
    const roster = [...this.sessions.values()].map((p) => ({
      id: p.pid, name: p.name, host: p.host, ready: p.ready, answered: p.answered, left: !!p.abandoned,
    }));
    const settings = this.settings;

    switch (session.stage) {
      case 'quiz':
        return { phase: 'quiz', me, roster, settings, round: this.roundInfo(session), question: this.questionInfo(session) };
      case 'result':
        return {
          phase: 'result', me, roster, settings,
          round: { no: session.round.no, total: session.round.total, type: session.question?.qtype || '', typeLabel: TYPE_NAMES[session.question?.qtype] || '' },
          result: this.resultInfo(session),
          scores: this.scoreboard(session),
        };
      case 'final':
        // 新一局刚开始、统计已清空时，先不渲染终局页，避免缺少榜单
        if (this.finalList) return { phase: 'final', me, final: this.finalInfo(session) };
        return { phase: 'lobby', me, roster, settings };
      default:
        return { phase: 'lobby', me, roster, settings };
    }
  }

  // 难度统一取房主的设置：竞技模式的同一个单词与计分基数、抢答模式的题目都以此为准（与服务器一致）。
  // 房主离线时退回到当前会话自己的难度，只是显示上的兜底
  hostLevel(session) {
    const host = [...this.sessions.values()].find((s) => s.host);
    return (host || session).level;
  }

  roundInfo(session) {
    const q = session.question;
    const level = this.hostLevel(session);
    return {
      no: session.round.no,
      total: session.round.total,
      type: q.qtype,
      typeLabel: TYPE_NAMES[q.qtype],
      level,
      levelName: LEVEL_NAMES[level],
    };
  }

  questionInfo(session) {
    const q = session.question;
    const input = q.options
      ? { kind: 'choice', options: q.options }
      : { kind: 'text', hint: q.initial ? `${q.initial}…` : undefined };
    return {
      display: { kind: q.kind, text: q.text },
      input,
      remainMs: Math.max(0, session.deadline - Date.now()),
      submitted: session.answered,
      locked: false,        // 服务器不推送抢答锁定状态
      buzzedBy: null,       // 服务器不推送是谁先按铃
      buzzVerdict: session.buzzVerdict,   // 抢答即时判分：'correct' | 'wrong' | null
      buzzPoints: session.buzzPoints,
    };
  }

  resultInfo(session) {
    const r = session.result;
    return {
      verdict: r.verdict,
      yourAnswer: session.timedOut ? null : session.answerLabel,
      gain: r.points,
      combo: r.combo,
      word: r.english,
      phonetic: r.phonetic,
      senses: r.senses,
      pauseMs: this.settings.pause * 1000,
    };
  }

  // 结果页排行榜：分数增量来自统计；状态只有自己能确定（服务器只对自己发 RESULT）
  scoreboard(session) {
    const idOf = this.idMap();
    return this.scoreOrder.map((name) => {
      const t = this.scores.get(name);
      return {
        id: idOf.get(name) ?? name,
        name,
        score: t.score,
        delta: t.delta,
        status: name === session.name ? session.result.verdict : null,
      };
    }).sort((a, b) => b.score - a.score);
  }

  finalInfo(session) {
    const idOf = this.idMap();
    const ranking = (this.finalList || []).map((e, i) => {
      const t = this.scores.get(e.name) || {};
      return {
        rank: i + 1,
        id: idOf.get(e.name) ?? e.name,
        name: e.name,
        score: e.score,
        correct: t.correct ?? 0,
        total: t.total ?? 0,
        maxCombo: t.maxCombo ?? 0,
      };
    });
    const mine = ranking.find((r) => r.name === session.name);
    return {
      champion: ranking[0] ? { name: ranking[0].name, score: ranking[0].score } : null,
      ranking,
      myRank: mine ? mine.rank : null,
      myScore: this.scoreOf(session.name),
      isHost: session.host,
    };
  }

  idMap() {
    return new Map([...this.sessions.values()].map((s) => [s.name, s.pid]));
  }

  scoreOf(name) {
    return this.scores.get(name)?.score ?? 0;
  }

  comboOf(name) {
    return this.scores.get(name)?.combo ?? 0;
  }
}
