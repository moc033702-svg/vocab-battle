import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  clientLine, parseServerLine, parseSenses, parseScoreList,
  validateName, validateTypes, validateSettings, sanitizeAnswer, validateRound,
  ProtocolError, DEFAULT_SETTINGS,
} from '../gateway/protocol.js';

describe('客户端行（网关 → C++）', () => {
  test('JOIN 带上昵称，去掉首尾空白', () => {
    assert.equal(clientLine.join('  小明 '), 'JOIN 小明');
  });

  test('LEVEL 与 TYPES 使用 C++ 认识的代号', () => {
    assert.equal(clientLine.level('kaoyan'), 'LEVEL kaoyan');
    assert.equal(clientLine.types(['spell', 'mcq']), 'TYPES mcq,spell');
  });

  test('START 只接受 race 或 buzz', () => {
    assert.equal(clientLine.start('race'), 'START race');
    assert.equal(clientLine.start('buzz'), 'START buzz');
    assert.throws(() => clientLine.start('quiz'), ProtocolError);
  });

  test('SETTINGS 按 <轮数> <秒数> <连击1/0> <停顿> 序列化', () => {
    assert.equal(clientLine.settings({ mode: 'race', rounds: 10, seconds: 15, combo: true, pause: 3 }), 'SETTINGS 10 15 1 3');
    assert.equal(clientLine.settings({ mode: 'buzz', rounds: 1, seconds: 300, combo: false, pause: 0 }), 'SETTINGS 1 300 0 0');
  });

  test('ANSWER 带题号；空答案不留尾随空格', () => {
    assert.equal(clientLine.answer(3, 'C'), 'ANSWER 3 C');
    assert.equal(clientLine.answer(3, ''), 'ANSWER 3');
  });

  test('ANSWER 中的换行和控制字符被去掉，不能拆出第二条消息', () => {
    assert.equal(clientLine.answer(2, 'ab\r\nTIMEOUT 9'), 'ANSWER 2 abTIMEOUT 9');
    assert.equal(clientLine.answer(2, 'x\u0007y'), 'ANSWER 2 xy');
  });

  test('TIMEOUT、NUDGE、WAIT、EXIT、QUIT 的固定格式', () => {
    assert.equal(clientLine.timeout(4), 'TIMEOUT 4');
    assert.equal(clientLine.nudge(), 'NUDGE');
    assert.equal(clientLine.wait(), 'WAIT');
    assert.equal(clientLine.exit(), 'EXIT');
    assert.equal(clientLine.quit(), 'QUIT');
  });

  test('非法参数在生成行之前就被拒绝', () => {
    assert.throws(() => clientLine.join('a=b'), ProtocolError);
    assert.throws(() => clientLine.level('pro'), ProtocolError);
    assert.throws(() => clientLine.types(['mcq', 'nope']), ProtocolError);
    assert.throws(() => clientLine.answer(0, 'A'), ProtocolError);
    assert.throws(() => clientLine.timeout(1.5), ProtocolError);
  });
});

describe('服务器行（C++ → 网关）：握手与状态', () => {
  test('握手提示', () => {
    assert.deepEqual(parseServerLine('WELCOME 欢迎来到英语词汇比拼擂台！'), { type: 'welcome', text: '欢迎来到英语词汇比拼擂台！' });
    assert.deepEqual(parseServerLine('ASK_NAME'), { type: 'ask_name' });
    assert.deepEqual(parseServerLine('ASK_LEVEL'), { type: 'ask_level' });
    assert.deepEqual(parseServerLine('ASK_TYPES'), { type: 'ask_types' });
    assert.deepEqual(parseServerLine('ASK_START'), { type: 'ask_start' });
  });

  test('ASK_SETTINGS 给出默认轮数与秒数', () => {
    assert.deepEqual(parseServerLine('ASK_SETTINGS 10 20'), { type: 'ask_settings', rounds: 10, seconds: 20 });
  });

  test('RECONNECTED 与 ROLE', () => {
    assert.deepEqual(parseServerLine('RECONNECTED 小明'), { type: 'reconnected', name: '小明' });
    assert.deepEqual(parseServerLine('ROLE host'), { type: 'role', host: true });
    assert.deepEqual(parseServerLine('ROLE guest'), { type: 'role', host: false });
  });

  test('WAIT、INFO、ERROR 保留正文', () => {
    assert.deepEqual(parseServerLine('WAIT 已就绪！等待其他玩家...'), { type: 'wait', text: '已就绪！等待其他玩家...' });
    assert.deepEqual(parseServerLine('INFO 玩家 小红 催促你开始比赛'), { type: 'info', text: '玩家 小红 催促你开始比赛' });
    assert.deepEqual(parseServerLine('ERROR 该昵称已被使用，请换一个'), { type: 'error', text: '该昵称已被使用，请换一个' });
  });

  test('RESTART 与 BYE', () => {
    assert.deepEqual(parseServerLine('RESTART 再来一局！等待房主开赛...'), { type: 'restart', text: '再来一局！等待房主开赛...' });
    assert.deepEqual(parseServerLine('BYE 服务器已关闭，再见！'), { type: 'bye', text: '服务器已关闭，再见！' });
  });

  test('行首尾空白和 \\r 不影响解析', () => {
    assert.deepEqual(parseServerLine('ROUND 2 10\r'), { type: 'round', no: 2, total: 10 });
  });
});

describe('服务器行（C++ → 网关）：对局', () => {
  test('ROUND 与 TIME', () => {
    assert.deepEqual(parseServerLine('ROUND 3 10'), { type: 'round', no: 3, total: 10 });
    assert.deepEqual(parseServerLine('TIME 15'), { type: 'time', seconds: 15 });
  });

  test('QUESTION mcq：单词加四个选项，选项标为 A–D', () => {
    assert.deepEqual(parseServerLine('QUESTION mcq|abandon|放弃|遗忘|放任|狂热'), {
      type: 'question', qtype: 'mcq', kind: 'word', text: 'abandon',
      options: [{ key: 'A', text: '放弃' }, { key: 'B', text: '遗忘' }, { key: 'C', text: '放任' }, { key: 'D', text: '狂热' }],
      initial: null,
    });
  });

  test('QUESTION zh2en_mcq：释义题面，选项为英文', () => {
    const q = parseServerLine('QUESTION zh2en_mcq|放弃|abandon|brief|brave|cheap');
    assert.equal(q.kind, 'meaning');
    assert.equal(q.text, '放弃');
    assert.deepEqual(q.options.map((o) => o.text), ['abandon', 'brief', 'brave', 'cheap']);
  });

  test('QUESTION en2zh 与 zh2en 为文本作答，没有选项', () => {
    assert.deepEqual(parseServerLine('QUESTION en2zh|brief'), {
      type: 'question', qtype: 'en2zh', kind: 'word', text: 'brief', options: null, initial: null,
    });
    assert.deepEqual(parseServerLine('QUESTION zh2en|简短的'), {
      type: 'question', qtype: 'zh2en', kind: 'meaning', text: '简短的', options: null, initial: null,
    });
  });

  test('QUESTION spell：释义加首字母提示', () => {
    assert.deepEqual(parseServerLine('QUESTION spell|模棱两可的|a'), {
      type: 'question', qtype: 'spell', kind: 'meaning', text: '模棱两可的', options: null, initial: 'a',
    });
  });

  test('题面字段数量不对时当作未知消息，不抛错', () => {
    assert.equal(parseServerLine('QUESTION mcq|abandon|只有一个选项').type, 'unknown');
    assert.equal(parseServerLine('QUESTION nope|x').type, 'unknown');
    assert.equal(parseServerLine('QUESTION noseparator').type, 'unknown');
  });

  test('RESULT：状态、得分、连击、答案回显与释义', () => {
    const r = parseServerLine('RESULT correct|3|2|abandon|əˈbænd(ə)n|v. 丢弃/放弃;vt. 离弃');
    assert.equal(r.type, 'result');
    assert.equal(r.verdict, 'correct');
    assert.equal(r.points, 3);
    assert.equal(r.combo, 2);
    assert.equal(r.english, 'abandon');
    assert.equal(r.phonetic, 'əˈbænd(ə)n');
    assert.deepEqual(r.senses, [
      { pos: 'v.', text: '丢弃/放弃' },
      { pos: 'vt.', text: '离弃' },
    ]);
  });

  test('RESULT 四种状态都能解析；未知状态当作未知消息', () => {
    for (const v of ['correct', 'wrong', 'timeout', 'missed']) {
      assert.equal(parseServerLine(`RESULT ${v}|0|0|x||`).verdict, v);
    }
    assert.equal(parseServerLine('RESULT maybe|0|0|x||').type, 'unknown');
  });

  test('RESULT 释义里即使含 | 也不会被截断', () => {
    const r = parseServerLine('RESULT wrong|0|0|brief|briːf|n. 概要|摘要');
    assert.equal(r.chinese, 'n. 概要|摘要');
  });

  test('SCORES 名单', () => {
    assert.deepEqual(parseServerLine('SCORES 小明=12,王芳=7,李华=0'), {
      type: 'scores',
      list: [{ name: '小明', score: 12 }, { name: '王芳', score: 7 }, { name: '李华', score: 0 }],
    });
    assert.deepEqual(parseServerLine('SCORES'), { type: 'scores', list: [] });
  });

  test('FINAL：名次加名单', () => {
    assert.deepEqual(parseServerLine('FINAL 2|小明=12,王芳=7'), {
      type: 'final', rank: 2, list: [{ name: '小明', score: 12 }, { name: '王芳', score: 7 }],
    });
  });

  test('未知命令原样保留', () => {
    assert.deepEqual(parseServerLine('HELLO world'), { type: 'unknown', raw: 'HELLO world' });
    assert.deepEqual(parseServerLine(''), { type: 'unknown', raw: '' });
  });
});

describe('解析辅助函数', () => {
  test('释义拆分：有词性与无词性两种', () => {
    assert.deepEqual(parseSenses('n. 原因/理由;vt. 引起'), [
      { pos: 'n.', text: '原因/理由' },
      { pos: 'vt.', text: '引起' },
    ]);
    assert.deepEqual(parseSenses('纯中文释义'), [{ pos: '', text: '纯中文释义' }]);
    assert.deepEqual(parseSenses(''), []);
  });

  test('名单解析：幽灵项（空名字）原样保留，交给上层过滤', () => {
    assert.deepEqual(parseScoreList('=0,小明=5'), [{ name: '', score: 0 }, { name: '小明', score: 5 }]);
  });
});

describe('输入校验', () => {
  test('昵称：1–16 个字符，不能含分隔符或控制字符', () => {
    assert.equal(validateName(' 小明 '), '小明');
    assert.equal(validateName('a'.repeat(16)), 'a'.repeat(16));
    assert.equal(validateName('一'.repeat(16)), '一'.repeat(16));
    assert.throws(() => validateName('   '), ProtocolError);
    assert.throws(() => validateName('a'.repeat(17)), ProtocolError);
    assert.throws(() => validateName('a,b'), ProtocolError);
    assert.throws(() => validateName('a=b'), ProtocolError);
    assert.throws(() => validateName('a|b'), ProtocolError);
    assert.throws(() => validateName('a\nb'), ProtocolError);
    assert.throws(() => validateName(undefined), ProtocolError);
  });

  test('题型：去重后按固定顺序返回，未知题型报错', () => {
    assert.deepEqual(validateTypes(['spell', 'mcq', 'spell']), ['mcq', 'spell']);
    assert.throws(() => validateTypes([]), ProtocolError);
    assert.throws(() => validateTypes(['mcq', 'fill']), ProtocolError);
    assert.throws(() => validateTypes('mcq'), ProtocolError);
  });

  test('开局参数：默认值补齐；越界和类型错误直接报错', () => {
    assert.deepEqual(validateSettings({ mode: 'buzz' }), { ...DEFAULT_SETTINGS, mode: 'buzz' });
    assert.throws(() => validateSettings({ rounds: 0 }), ProtocolError);
    assert.throws(() => validateSettings({ rounds: 101 }), ProtocolError);
    assert.throws(() => validateSettings({ seconds: 301 }), ProtocolError);
    assert.throws(() => validateSettings({ pause: 11 }), ProtocolError);
    assert.throws(() => validateSettings({ rounds: '10' }), ProtocolError);
    assert.throws(() => validateSettings({ rounds: 10.5 }), ProtocolError);
    assert.throws(() => validateSettings({ combo: 1 }), ProtocolError);
  });

  test('答案清洗与长度上限', () => {
    assert.equal(sanitizeAnswer('  Brief\n'), 'Brief');
    assert.equal(sanitizeAnswer(undefined), '');
    assert.throws(() => sanitizeAnswer('x'.repeat(65)), ProtocolError);
  });

  test('题号必须是正整数', () => {
    assert.equal(validateRound(1), 1);
    assert.throws(() => validateRound(0), ProtocolError);
    assert.throws(() => validateRound('1'), ProtocolError);
  });
});
