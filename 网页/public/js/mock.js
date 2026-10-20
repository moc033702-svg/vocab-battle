// 本地模拟后端：与真实网关使用同一套接口（api.js），用于 ?mock=1 时离线跑通整局。
// 真实网关的实现必须输出这里定义的视图结构，前端据此渲染。
//
// 视图结构（phase 决定屏幕）：
//   { phase: 'lobby',  me, roster, settings }
//   { phase: 'quiz',   me, roster, settings, round, question }
//   { phase: 'result', me, roster, settings, round, result, scores }
//   { phase: 'final',  me, final }
//   { phase: 'closed' }           房主关闭房间，所有人回到加入页
//
//   me:       { id, name, host, ready, score, combo }
//   roster:   [{ id, name, host, ready, answered }]
//   settings: { mode: 'race'|'buzz', rounds, seconds, combo, pause }
//   round:    { no, total, type, typeLabel, level, levelName }
//   question: { display: { kind: 'word'|'meaning', text, phonetic? },
//               input: { kind: 'choice', options: [{ key, text }] } | { kind: 'text', hint? },
//               remainMs, submitted, locked, buzzedBy }
//   result:   { verdict: 'correct'|'wrong'|'timeout'|'missed', yourAnswer, gain, combo,
//               word, phonetic, senses: [{ pos, text }], pauseMs }
//   scores:   [{ id, name, score, delta, status }]
//   final:    { champion: { name, score }, ranking: [{ rank, id, name, score, correct, total, maxCombo }],
//               myRank, myScore, isHost }

const WORDS = [
  {
    word: 'abandon', phonetic: 'əˈbænd(ə)n', meaning: '放弃；丢弃',
    senses: [{ pos: 'v.', text: '丢弃；放弃；抛弃' }, { pos: 'vt.', text: '离弃；遗弃' }, { pos: 'n.', text: '放任；纵情' }],
    choices: ['丢弃；放弃', '遗忘；忽略', '放任；纵情', '狂热；忠诚'], answer: 2,
  },
  {
    word: 'ambiguous', phonetic: 'æmˈbɪɡjuəs', meaning: '模棱两可的',
    senses: [{ pos: 'adj.', text: '模棱两可的；引起歧义的' }],
    choices: ['清晰明确的', '模棱两可的', '精彩的', '贫穷的'], answer: 1,
  },
  {
    word: 'brief', phonetic: 'briːf', meaning: '简短的；短暂的',
    senses: [{ pos: 'adj.', text: '简短的；短暂的' }, { pos: 'n.', text: '概要；摘要' }],
    choices: ['漫长的', '简短的', '沉重的', '安静的'], answer: 1,
  },
];

const TYPE_LABELS = { mcq: '英译中选择', zh2en_mcq: '中译英选择', en2zh: '英译中', zh2en: '中译英', spell: '拼写' };
const BASE = { cet4: 1, cet6: 2, kaoyan: 3, ielts: 4, toefl: 5, gre: 6 };
const LEVEL_NAMES = { cet4: 'CET4 四级', cet6: 'CET6 六级', kaoyan: '考研', ielts: '雅思', toefl: '托福', gre: 'GRE 美国研究生' };
const BOT_NAMES = ['李华', '王芳'];
const DEFAULT_SETTINGS = { mode: 'race', rounds: 3, seconds: 10, combo: true, pause: 3 };

export function createMockApi({ role = 'host' } = {}) {
  let me = null;           // 当前玩家
  let roster = [];         // 名单
  let settings = { ...DEFAULT_SETTINGS };
  let phase = 'closed';    // 尚未加入
  let round = null;        // { no, total, type, word, options, deadline, answers }
  let result = null;
  let final = null;
  let timers = [];
  let listeners = new Set();
  let notices = [];
  let chatLog = [];
  let chatSeq = 0;
  const emit = (fn) => listeners.forEach((l) => fn(l));

  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };

  const view = () => {
    const rosterView = roster.map((p) => ({
      id: p.id, name: p.name, host: p.host, ready: p.ready, answered: !!(round && round.answers[p.id]), left: false,
    }));
    const meView = { id: me.id, name: me.name, host: me.host, ready: me.ready, score: me.score, combo: me.combo };
    if (phase === 'lobby') return { phase, me: meView, roster: rosterView, settings };
    if (phase === 'quiz') {
      const w = round.word;
      // 与真实网关一致（见 gateway/protocol.js 的 QUESTION_SHAPE）
      const meaning = round.type === 'zh2en_mcq' || round.type === 'zh2en' || round.type === 'spell';
      const choice = round.type === 'mcq' || round.type === 'zh2en_mcq';
      const display = meaning
        ? { kind: 'meaning', text: w.meaning }
        : { kind: 'word', text: w.word, phonetic: w.phonetic };
      return {
        phase, me: meView, roster: rosterView, settings,
        round: { no: round.no, total: settings.rounds, type: round.type, typeLabel: TYPE_LABELS[round.type], level: 'kaoyan', levelName: LEVEL_NAMES.kaoyan },
        question: {
          display,
          input: choice
            ? { kind: 'choice', options: ['A', 'B', 'C', 'D'].map((key, i) => ({ key, text: w.choices[i] })) }
            : { kind: 'text', hint: round.type === 'spell' ? `${w.word[0]}${'_'.repeat(w.word.length - 1)}` : undefined },
          remainMs: Math.max(0, round.deadline - Date.now()),
          submitted: !!round.answers.me,
          locked: false,
          buzzedBy: null,
          buzzVerdict: null,
          buzzPoints: 0,
        },
      };
    }
    if (phase === 'result') {
      return {
        phase, me: meView, roster: rosterView, settings,
        round: { no: round.no, total: settings.rounds, type: round.type, typeLabel: TYPE_LABELS[round.type] },
        result,
        scores: roster.map((p) => ({ id: p.id, name: p.name, score: p.score, delta: p.delta || 0, status: p.lastStatus || 'wrong' }))
          .sort((a, b) => b.score - a.score),
      };
    }
    if (phase === 'final') return { phase, me: meView, final };
    return { phase: 'closed' };
  };
  const push = () => emit((l) => l.onView(view()));

  function startRound(no) {
    const type = pickType(no);
    const word = WORDS[(no - 1) % WORDS.length];
    round = { no, type, word, deadline: Date.now() + settings.seconds * 1000, answers: {}, typed: null };
    roster.forEach((p) => { p.delta = 0; });
    phase = 'quiz';
    push();
    // 机器人随机作答
    BOT_NAMES.forEach((name) => {
      const p = roster.find((x) => x.name === name);
      if (!p) return;
      later(1000 + Math.random() * 3000, () => {
        if (phase !== 'quiz' || round.answers[p.id]) return;
        const correct = Math.random() < 0.6;
        round.answers[p.id] = correct ? 'correct' : 'wrong';
        checkAllAnswered();
        push();
      });
    });
    later(settings.seconds * 1000, () => endRound());
  }

  // 模拟：奇数轮选择题，偶数轮拼写
  function pickType(no) {
    return no % 2 === 1 ? 'mcq' : 'spell';
  }

  function checkAllAnswered() {
    if (roster.every((p) => round.answers[p.id])) later(600, () => endRound());
  }

  function endRound() {
    if (phase !== 'quiz') return;
    clearTimers();
    const w = round.word;
    roster.forEach((p) => {
      const state = round.answers[p.id] || 'timeout';
      const correct = state === 'correct';
      const gain = correct ? BASE.kaoyan * (settings.combo ? Math.min(3, 1 + Math.floor(p.combo / 3)) : 1) : 0;
      if (correct) { p.combo += 1; p.correct = (p.correct || 0) + 1; } else { p.combo = 0; }
      p.maxCombo = Math.max(p.maxCombo || 0, p.combo);
      p.total = (p.total || 0) + 1;
      p.score += gain;
      p.delta = gain;
      p.lastStatus = correct ? 'correct' : state === 'timeout' ? 'timeout' : 'wrong';
    });
    const mine = round.answers.me;
    result = {
      verdict: mine === 'correct' ? 'correct' : mine === 'wrong' ? 'wrong' : 'timeout',
      yourAnswer: round.typed,
      gain: me.delta, combo: me.combo,
      word: w.word, phonetic: w.phonetic, senses: w.senses,
      pauseMs: settings.pause * 1000,
    };
    phase = 'result';
    push();
    later(settings.pause * 1000, () => {
      if (round.no >= settings.rounds) finish();
      else startRound(round.no + 1);
    });
  }

  function finish() {
    clearTimers();
    const ranking = [...roster].sort((a, b) => b.score - a.score).map((p, i) => ({
      rank: i + 1, id: p.id, name: p.name, score: p.score, correct: p.correct || 0, total: p.total || 0, maxCombo: p.maxCombo || 0,
    }));
    const top = ranking[0];
    final = { champion: { name: top.name, score: top.score }, ranking, myRank: ranking.find((r) => r.id === me.id).rank, myScore: me.score, isHost: me.host };
    phase = 'final';
    push();
  }

  function resetScores() {
    roster.forEach((p) => { p.score = 0; p.combo = 0; p.correct = 0; p.total = 0; });
  }

  return {
    async join({ name, level, types }) {
      if (!name || name.length > 16 || /[,=|]/.test(name)) throw new Error('昵称不合法：1–16 个字符，不能含 , = |');
      if (name === '重名') throw new Error('昵称已被占用，请换一个');
      void level; void types;
      me = { id: 'me', name, host: role !== 'guest', ready: true, score: 0, combo: 0 };
      const bots = BOT_NAMES.map((n, i) => ({ id: `bot${i}`, name: n, host: false, ready: true, score: 0, combo: 0 }));
      // 访客时房主是另一个人
      const host = role === 'guest' ? [{ id: 'host', name: '小明', host: true, ready: true, score: 0, combo: 0 }] : [];
      roster = [...host, me, ...bots];
      phase = 'lobby';
      return { sid: 'mock-session' };
    },

    subscribe(_sid, handlers) {
      const listener = handlers;
      listeners.add(listener);
      later(0, () => {
        listener.onOpen && listener.onOpen();
        listener.onView(view());
        if (chatLog.length) listener.onChatHistory && listener.onChatHistory(chatLog);
      });
      return () => listeners.delete(listener);
    },

    // 房间公屏：答题中不允许发言，与真实网关一致
    async chat(_sid, raw) {
      const text = String(raw ?? '').trim();
      if (phase === 'quiz') throw new Error('答题进行中，暂不能发言');
      if (!text) throw new Error('不能发送空消息');
      const msg = { id: ++chatSeq, name: me.name, host: me.host, text, at: Date.now() };
      chatLog = [...chatLog, msg].slice(-60);
      emit((l) => l.onChat && l.onChat(msg));
      return { ok: true };
    },

    async act(_sid, payload) {
      const type = payload.type;
      if (type === 'start' || (type === 'restart')) {
        if (payload.settings) settings = { ...settings, ...payload.settings };
        resetScores();
        phase = 'quiz';
        startRound(1);
        return {};
      }
      if (type === 'answer') {
        if (phase !== 'quiz' || round.answers.me) return {};
        const choice = payload.answer;
        const w = round.word;
        const correct = round.type === 'mcq'
          ? choice === ['A', 'B', 'C', 'D'][w.answer]
          : String(choice || '').trim().toLowerCase() === w.word;
        round.answers.me = correct ? 'correct' : 'wrong';
        round.typed = round.type === 'mcq' ? `${choice}：${w.choices[['A', 'B', 'C', 'D'].indexOf(choice)]}` : String(choice || '');
        checkAllAnswered();
        push();
        return {};
      }
      if (type === 'nudge') {
        const host = roster.find((p) => p.host);
        emit((l) => l.onNotice({ text: `${me.name} 催促房主`, kind: 'info' }));
        void host;
        return {};
      }
      if (type === 'exit') {
        clearTimers();
        phase = 'closed';
        push();
        return {};
      }
      if (type === 'leave') {
        clearTimers();
        phase = 'closed';
        push();
        return {};
      }
      return {};
    },

    async stats() {
      return {
        matches: 12,
        total: [
          { rank: 1, name: '小明', wins: 4, points: 96, matches: 12, correct: 46 },
          { rank: 2, name: '李华', wins: 3, points: 88, matches: 11, correct: 40 },
          { rank: 3, name: '张伟', wins: 2, points: 61, matches: 10, correct: 28 },
          { rank: 4, name: '王芳', wins: 1, points: 35, matches: 7, correct: 15 },
        ],
        recent: [
          { title: '考研 · 竞技 · 10 轮', at: '2026-10-19 19:20', players: 6, champion: '小明', score: 12 },
          { title: 'CET6 · 抢答 · 8 轮', at: '2026-10-18 20:05', players: 4, champion: '李华', score: 9 },
          { title: '雅思 · 竞技 · 10 轮', at: '2026-10-17 18:40', players: 3, champion: '小明', score: 14 },
        ],
      };
    },
  };
}
