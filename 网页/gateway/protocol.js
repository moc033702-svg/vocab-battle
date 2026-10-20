// 行协议的纯函数：浏览器一侧的 JSON 参数 ⇄ C++ 服务器的文本行。
// 不碰网络与状态，便于单测。线格式以 src/server.cpp、src/game.cpp、src/protocol.h 为准。

export const LEVELS = ['cet4', 'cet6', 'kaoyan', 'ielts', 'toefl', 'gre'];
export const QTYPES = ['mcq', 'zh2en_mcq', 'en2zh', 'zh2en', 'spell'];
// 前端的 race 对应界面上的「竞技」，buzz 对应「抢答」；线上两者分别是 START race / START buzz
export const MODES = ['race', 'buzz'];
export const VERDICTS = ['correct', 'wrong', 'timeout', 'missed'];

export const LIMITS = {
  nameMax: 16,
  answerMax: 64,
  rounds: { min: 1, max: 100 },
  seconds: { min: 1, max: 300 },
  pause: { min: 0, max: 10 },
};

// 与 public/ui/screens.js 里的 draft 默认值保持一致
export const DEFAULT_SETTINGS = { mode: 'race', rounds: 10, seconds: 15, combo: true, pause: 3 };

// status 是 HTTP 状态码，路由层直接用它回应；默认 400
export class ProtocolError extends Error {
  constructor(message, field, status = 400) {
    super(message);
    this.name = 'ProtocolError';
    this.field = field;
    this.status = status;
  }
}

// 与 src/protocol.h、public/js/mock.js 的显示名保持一致
export const LEVEL_NAMES = {
  cet4: 'CET4 四级', cet6: 'CET6 六级', kaoyan: '考研', ielts: '雅思', toefl: '托福', gre: 'GRE 美国研究生',
};
export const TYPE_NAMES = {
  mcq: '英译中选择', zh2en_mcq: '中译英选择', en2zh: '英译中', zh2en: '中译英', spell: '拼写',
};

// ---------------- 输入校验（进入行协议之前） ----------------

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

// 昵称：去首尾空白后 1–16 个字符（按码点计，一个汉字算一个），不含 , = | 与控制字符
export function validateName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new ProtocolError('请输入昵称', 'name');
  if ([...name].length > LIMITS.nameMax) throw new ProtocolError(`昵称最多 ${LIMITS.nameMax} 个字符`, 'name');
  if (/[,=|\u0000-\u001f\u007f]/.test(name)) throw new ProtocolError('昵称不能包含 , = | 或控制字符', 'name');
  return name;
}

export function validateLevel(level) {
  if (!LEVELS.includes(level)) throw new ProtocolError('无效的难度等级', 'level');
  return level;
}

// 题型：至少一种，且只能是已知题型；返回按 QTYPES 固定顺序排列的数组
export function validateTypes(types) {
  if (!Array.isArray(types)) throw new ProtocolError('请选择题型', 'types');
  if (types.some((t) => !QTYPES.includes(t))) throw new ProtocolError('无效的题型', 'types');
  const picked = QTYPES.filter((t) => types.includes(t));
  if (picked.length === 0) throw new ProtocolError('至少选择一种题型', 'types');
  return picked;
}

export function validateMode(mode) {
  if (!MODES.includes(mode)) throw new ProtocolError('无效的模式', 'mode');
  return mode;
}

function validInt(value, { min, max }, message, field) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ProtocolError(message, field);
  }
  return value;
}

// 开局参数。缺省的字段取 base 的值；不合法直接报错，不做静默截断
export function validateSettings(input = {}, base = DEFAULT_SETTINGS) {
  const pick = (key) => (input[key] !== undefined ? input[key] : base[key]);
  const combo = pick('combo');
  if (typeof combo !== 'boolean') throw new ProtocolError('连击开关必须是布尔值', 'combo');
  return {
    mode: validateMode(pick('mode')),
    rounds: validInt(pick('rounds'), LIMITS.rounds, `轮数必须是 ${LIMITS.rounds.min}–${LIMITS.rounds.max} 的整数`, 'rounds'),
    seconds: validInt(pick('seconds'), LIMITS.seconds, `每题秒数必须是 ${LIMITS.seconds.min}–${LIMITS.seconds.max} 的整数`, 'seconds'),
    combo,
    pause: validInt(pick('pause'), LIMITS.pause, `停顿秒数必须是 ${LIMITS.pause.min}–${LIMITS.pause.max} 的整数`, 'pause'),
  };
}

// 答案会放进按行分帧的协议，控制字符（含换行）必须去掉
export function sanitizeAnswer(raw) {
  const text = (typeof raw === 'string' ? raw : '').replace(CONTROL_CHARS, '').trim();
  if ([...text].length > LIMITS.answerMax) throw new ProtocolError(`答案最多 ${LIMITS.answerMax} 个字符`, 'answer');
  return text;
}

export function validateRound(round) {
  if (!Number.isInteger(round) || round < 1) throw new ProtocolError('题号无效', 'round');
  return round;
}

// ---------------- 网关 → 服务器（客户端行） ----------------

// 每个函数返回一行文本（不含换行）。参数先校验，保证发出去的行一定能被 C++ 正确切分
export const clientLine = {
  join: (name) => `JOIN ${validateName(name)}`,
  level: (level) => `LEVEL ${validateLevel(level)}`,
  types: (types) => `TYPES ${validateTypes(types).join(',')}`,
  start: (mode) => `START ${validateMode(mode)}`,
  settings: (settings) => {
    const s = validateSettings(settings);
    return `SETTINGS ${s.rounds} ${s.seconds} ${s.combo ? 1 : 0} ${s.pause}`;
  },
  answer: (round, answer) => `ANSWER ${validateRound(round)} ${sanitizeAnswer(answer)}`.trimEnd(),
  timeout: (round) => `TIMEOUT ${validateRound(round)}`,
  nudge: () => 'NUDGE',
  wait: () => 'WAIT',
  exit: () => 'EXIT',
  quit: () => 'QUIT',
};

// ---------------- 服务器 → 网关（服务器行） ----------------

function toInt(text) {
  return parseInt(text, 10) || 0;
}

// 释义文本形如 "n. 原因/理由;vt. 引起"（见 word_bank.h 的 display()），拆成 {pos, text}
export function parseSenses(text) {
  if (!text) return [];
  return text
    .split(';')
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => {
      const m = /^([A-Za-z]+\.)\s*(.*)$/.exec(seg);
      return m ? { pos: m[1], text: m[2] } : { pos: '', text: seg };
    });
}

// SCORES / FINAL 里的名单："name=score,name=score"。名字为空的项（幽灵玩家）原样保留，由上层过滤
export function parseScoreList(text) {
  if (!text) return [];
  return text
    .split(',')
    .map((item) => {
      const i = item.lastIndexOf('=');
      if (i < 0) return null;
      return { name: item.slice(0, i), score: toInt(item.slice(i + 1)) };
    })
    .filter(Boolean);
}

// 题面载荷按题型解释（见 game.cpp 的 makeQuestion）：
//   mcq:      单词|A|B|C|D            zh2en_mcq: 释义|A|B|C|D
//   en2zh:    单词                    zh2en:     释义
//   spell:    释义|首字母
const QUESTION_SHAPE = {
  mcq: { kind: 'word', options: true },
  zh2en_mcq: { kind: 'meaning', options: true },
  en2zh: { kind: 'word', options: false },
  zh2en: { kind: 'meaning', options: false },
  spell: { kind: 'meaning', options: false, initial: true },
};

function parseQuestion(qtype, payload) {
  const shape = QUESTION_SHAPE[qtype];
  const f = payload.split('|');
  if (!shape) return { type: 'unknown', raw: `${qtype}|${payload}` };
  if (shape.options) {
    if (f.length < 5) return { type: 'unknown', raw: `${qtype}|${payload}` };
    return {
      type: 'question', qtype, kind: shape.kind, text: f[0],
      options: ['A', 'B', 'C', 'D'].map((key, i) => ({ key, text: f[i + 1] })),
      initial: null,
    };
  }
  return {
    type: 'question', qtype, kind: shape.kind, text: f[0],
    options: null,
    initial: shape.initial ? f[1] || null : null,
  };
}

// 解析一行服务器消息。无法识别的返回 { type: 'unknown', raw }，由调用方记录而不是抛错
export function parseServerLine(raw) {
  const line = String(raw).trim();
  const sp = line.indexOf(' ');
  const cmd = sp < 0 ? line : line.slice(0, sp);
  const rest = sp < 0 ? '' : line.slice(sp + 1).trim();

  switch (cmd) {
    case 'WELCOME': return { type: 'welcome', text: rest };
    case 'ASK_NAME': return { type: 'ask_name' };
    case 'ASK_LEVEL': return { type: 'ask_level' };
    case 'ASK_TYPES': return { type: 'ask_types' };
    case 'ASK_START': return { type: 'ask_start' };
    case 'ASK_SETTINGS': {
      const [rounds, seconds] = rest.split(/\s+/);
      return { type: 'ask_settings', rounds: toInt(rounds), seconds: toInt(seconds) };
    }
    case 'RECONNECTED': return { type: 'reconnected', name: rest };
    case 'ROLE': return { type: 'role', host: rest === 'host' };
    case 'WAIT': return { type: 'wait', text: rest };
    case 'INFO': return { type: 'info', text: rest };
    case 'ERROR': return { type: 'error', text: rest };
    case 'ROUND': {
      const [no, total] = rest.split(/\s+/);
      return { type: 'round', no: toInt(no), total: toInt(total) };
    }
    case 'TIME': return { type: 'time', seconds: toInt(rest) };
    case 'QUESTION': {
      const bar = rest.indexOf('|');
      if (bar < 0) return { type: 'unknown', raw: line };
      return parseQuestion(rest.slice(0, bar), rest.slice(bar + 1));
    }
    case 'RESULT': {
      const f = rest.split('|');
      if (!VERDICTS.includes(f[0])) return { type: 'unknown', raw: line };
      const chinese = f.slice(5).join('|');
      return {
        type: 'result',
        verdict: f[0],
        points: toInt(f[1]),
        combo: toInt(f[2]),
        english: f[3] || '',
        phonetic: f[4] || '',
        chinese,
        senses: parseSenses(chinese),
      };
    }
    case 'SCORES': return { type: 'scores', list: parseScoreList(rest) };
    case 'BUZZ_OK': return { type: 'buzz_ok', points: toInt(rest) };
    case 'BUZZ_NO': return { type: 'buzz_no' };
    case 'FINAL': {
      const bar = rest.indexOf('|');
      return {
        type: 'final',
        rank: toInt(bar < 0 ? rest : rest.slice(0, bar)),
        list: bar < 0 ? [] : parseScoreList(rest.slice(bar + 1)),
      };
    }
    case 'RESTART': return { type: 'restart', text: rest };
    case 'BYE': return { type: 'bye', text: rest };
    default: return { type: 'unknown', raw: line };
  }
}
