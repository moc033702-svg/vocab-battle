// 各屏幕的渲染函数。输入为 view（服务端视图）和 ui（前端本地状态），输出 { node, dispose }。
// dispose 用于清理定时器和键盘监听，每次重渲染前由 app.js 调用。
import { h, hueOf, initialOf, LEVEL_NAMES, TYPE_LABELS, TYPE_DESC, LEVEL_BASE_SCORE } from '../dom.js';
import { isFreshVerdict, playVerdictSound } from '../feedback.js';
import { addMistake } from '../mistakes.js';
import { icon } from './icons.js';

export const LIMITS = { rounds: [1, 100], seconds: [1, 300], pause: [0, 10] };

// 房主开赛设置草稿：跨重渲染保留，进入大厅时用服务端 settings 初始化一次
export const draft = { mode: 'race', rounds: 10, seconds: 15, combo: true, pause: 3 };

// ---------- 通用小组件 ----------

function avatar(name, cls = '') {
  return h('span', { class: `avatar ${cls}`.trim(), style: `--hue: ${hueOf(name)}`, 'aria-hidden': 'true' }, initialOf(name));
}

function topbar(eyebrow, title, actions = []) {
  return h('header', { class: 'topbar' },
    h('div', null, h('p', { class: 'eyebrow' }, eyebrow), h('h2', { class: 'topbar-title' }, title)),
    h('div', { class: 'topbar-actions' }, actions),
  );
}

function quizTop(meta, stats, ui) {
  const statsBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => ui.openStats() }, icon('chart'), '战绩');
  return h('header', { class: 'quiz-top' },
    h('div', { class: 'quiz-meta' }, meta.map((m) => h('span', { class: m.strong ? 'chip chip-strong' : 'chip' }, m.text))),
    h('div', { class: 'quiz-stats' }, stats, statsBtn),
  );
}

function roundBar(current, total, doneUpTo = current - 1) {
  const segs = [];
  for (let i = 1; i <= total; i += 1) {
    let cls = 'seg';
    if (i <= doneUpTo) cls += ' is-done';
    else if (i === current) cls += ' is-now';
    segs.push(h('span', { class: cls }));
  }
  return h('div', { class: 'round-bar', role: 'progressbar', 'aria-label': '轮次进度', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': current },
    segs);
}

/** 倒计时环。remainMs 是服务端给的剩余毫秒，前端自己倒数，避免时钟偏差。 */
function countdown(remainMs, totalMs) {
  const deadline = Date.now() + remainMs;
  const num = h('span', { class: 'timer-num' }, '');
  const arc = h('circle', { class: 'timer-arc', cx: 32, cy: 32, r: 26 });
  const wrap = h('div', { class: 'timer', role: 'timer' },
    h('svg', { viewBox: '0 0 64 64', 'aria-hidden': 'true' },
      h('circle', { class: 'timer-track', cx: 32, cy: 32, r: 26 }), arc),
    num);
  const tick = () => {
    const left = Math.max(0, deadline - Date.now());
    const sec = Math.ceil(left / 1000);
    num.textContent = String(sec);
    arc.style.setProperty('--frac', String(Math.min(1, left / totalMs)));
    wrap.classList.toggle('is-warn', sec <= 5);
    wrap.setAttribute('aria-label', `剩余 ${sec} 秒`);
  };
  tick();
  const id = setInterval(tick, 200);
  return { node: wrap, dispose: () => clearInterval(id) };
}

function stepper(label, hint, value, [min, max], onChange) {
  const clamp = (v) => Math.min(max, Math.max(min, v));
  const out = h('output', { class: 'step-val' }, String(value));
  const ctl = (delta, aria) => h('button', {
    type: 'button', class: 'step-btn', 'aria-label': aria,
    onClick: () => onChange(clamp(draft[label.key] + delta)),
  }, delta < 0 ? '−' : '+');
  return h('div', { class: 'stepper' },
    h('span', { class: 'field-label' }, label.text),
    h('div', { class: 'stepper-ctl' }, ctl(-1, '减少'), out, ctl(1, '增加')),
    h('span', { class: 'hint' }, hint));
}

// 难度卡片的短名与副标题（与设计稿一致）
const LEVEL_SHORT = { cet4: 'CET4', cet6: 'CET6', kaoyan: '考研', ielts: '雅思', toefl: '托福', gre: 'GRE' };
const LEVEL_SUB = { cet4: '四级', cet6: '六级', kaoyan: '研究生入学', ielts: 'IELTS', toefl: 'TOEFL', gre: '美国研究生' };

// ---------- 1. 加入页 ----------

export function joinScreen(form, { onName, onLevel, onType, onSubmit, error, busy }) {
  const levels = Object.keys(LEVEL_NAMES);
  const types = Object.keys(TYPE_LABELS);
  const submit = (e) => { e.preventDefault(); onSubmit(); };

  const node = h('section', { class: 'screen', 'aria-labelledby': 'join-title' },
    h('header', { class: 'brand' },
      h('div', { class: 'brand-mark', 'aria-hidden': 'true' }, '擂'),
      h('div', null,
        h('h1', { id: 'join-title', class: 'brand-title' }, '英语词汇擂台'),
        h('p', { class: 'brand-sub' }, '选好难度和题型，走上擂台'))),
    h('form', { class: 'card join-form', onSubmit: submit },
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: 'nickname' }, '你的昵称'),
        h('input', {
          id: 'nickname', class: 'input', type: 'text', maxlength: 16, autocomplete: 'nickname',
          placeholder: '1–16 个字符', value: form.name,
          onInput: (e) => onName(e.target.value),
        }),
        h('p', { class: 'hint' }, '不能包含 逗号 , 等号 = 竖线 |')),
      h('fieldset', { class: 'field' },
        h('legend', { class: 'field-label' }, '难度'),
        h('div', { class: 'level-grid' }, levels.map((key, i) => h('label', {
          class: `level-card${form.level === key ? ' is-selected' : ''}`, 'data-tone': i + 1,
        },
          h('input', { type: 'radio', name: 'level', value: key, checked: form.level === key, onChange: () => onLevel(key) }),
          h('span', { class: 'level-name' }, LEVEL_SHORT[key]),
          h('span', { class: 'level-sub' }, LEVEL_SUB[key]),
          h('span', { class: 'score-chip' }, `+${LEVEL_BASE_SCORE[key]} / 题`))))),
      h('fieldset', { class: 'field' },
        h('legend', { class: 'field-label' }, '题型', h('span', { class: 'hint-inline' }, '可多选 · 开赛时按房主设置')),
        h('div', { class: 'type-list' }, types.map((key) => {
          const on = form.types.includes(key);
          return h('label', { class: `type-card${on ? ' is-selected' : ''}` },
            h('input', { type: 'checkbox', checked: on, onChange: () => onType(key) }),
            h('span', { class: 'type-check', 'aria-hidden': 'true' }),
            h('span', { class: 'type-body' },
              h('span', { class: 'type-name' }, TYPE_LABELS[key]),
              h('span', { class: 'type-desc' }, TYPE_DESC[key])));
        }))),
      h('button', { type: 'submit', class: 'btn btn-primary btn-block', disabled: busy }, busy ? '正在进入…' : '进入擂台'),
      error ? h('p', { class: 'error', role: 'alert' }, error) : null,
    ));
  return { node, dispose() {} };
}

// ---------- 2. 大厅 ----------

export function lobbyScreen(view, act, ui) {
  const me = view.me;
  const roster = view.roster;
  const allReady = roster.length >= 2 && roster.every((p) => p.ready);
  const notReady = roster.filter((p) => !p.ready).length;

  const rosterList = h('ul', { class: 'roster' }, roster.map((p) => h('li', {
    class: `member${p.host ? ' is-host' : ''}${p.id === me.id ? ' is-me' : ''}${p.left ? ' is-left' : ''}`,
  },
    avatar(p.name),
    h('span', { class: 'member-name' }, p.name),
    p.id === me.id ? h('span', { class: 'badge badge-me' }, '你') : null,
    p.host ? h('span', { class: 'badge badge-host' }, '房主') : null,
    p.left ? h('span', { class: 'badge badge-left' }, '已退出') : null,
    h('span', { class: `ready-dot${p.ready && !p.left ? ' is-ready' : ''}`, title: p.left ? '已退出' : p.ready ? '已就绪' : '未就绪' }))));

  const shareBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => ui.share() }, icon('link'), '分享链接');
  const statsBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => ui.openStats() }, icon('chart'), '战绩');
  const leaveBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-danger-ghost', onClick: () => act({ type: 'leave' }) }, icon('logout'), '离开');

  const top = topbar('房间 · 等待开赛', '擂台大厅', [shareBtn, statsBtn, leaveBtn]);

  const rosterCard = h('section', { class: 'card', 'aria-labelledby': 'roster-h' },
    h('div', { class: 'card-head' },
      h('h3', { id: 'roster-h' }, '选手 ', h('span', { class: 'count' }, `${roster.length} 人`)),
      h('span', { class: 'hint-inline' }, '至少 2 人、全部就绪可开赛')),
    rosterList);

  let settingsCard;
  if (me.host) {
    const setMode = (mode) => { draft.mode = mode; ui.refresh(); };
    const modeCard = (key, glyph, name, desc) => h('label', { class: `mode-card${draft.mode === key ? ' is-selected' : ''}` },
      h('input', { type: 'radio', name: 'mode', checked: draft.mode === key, onChange: () => setMode(key) }),
      h('span', { class: 'mode-icon', 'aria-hidden': 'true' }, glyph),
      h('span', { class: 'mode-name' }, name),
      h('span', { class: 'mode-desc' }, desc));
    const set = (key) => (v) => { draft[key] = v; ui.refresh(); };
    const startBtn = h('button', {
      type: 'button', class: 'btn btn-primary btn-block btn-start', disabled: !allReady,
      onClick: () => act({ type: 'start', settings: { ...draft } }),
    }, '开始比赛');
    settingsCard = h('section', { class: 'card', 'aria-labelledby': 'settings-h' },
      h('div', { class: 'card-head' }, h('h3', { id: 'settings-h' }, '开赛设置')),
      h('p', { class: 'field-label' }, '模式'),
      h('div', { class: 'mode-grid', role: 'radiogroup' },
        modeCard('race', icon('bolt'), '竞技', '所有人同时答，按得分排名'),
        modeCard('buzz', icon('bell'), '抢答', '先按铃先答；答错则判负')),
      h('div', { class: 'stepper-row' },
        stepper({ key: 'rounds', text: '轮数' }, '1–100', draft.rounds, LIMITS.rounds, set('rounds')),
        stepper({ key: 'seconds', text: '每题秒数' }, '1–300', draft.seconds, LIMITS.seconds, set('seconds')),
        stepper({ key: 'pause', text: '轮间停顿' }, '0–10 秒', draft.pause, LIMITS.pause, set('pause'))),
      h('label', { class: 'switch-row' },
        h('span', { class: 'switch-text' },
          h('span', { class: 'field-label' }, '连击加成'),
          h('span', { class: 'hint' }, '连续答对每 3 题倍率 +1，最高 ×3')),
        h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: draft.combo, 'aria-label': '连击加成', onChange: (e) => set('combo')(e.target.checked) })),
      startBtn,
      h('p', { class: 'hint center' }, allReady ? '全部就绪，可以开始' : roster.length < 2 ? '至少需要 2 人才能开始' : `还有 ${notReady} 人未就绪，暂不能开始`));
  } else {
    const cooling = ui.nudgeCooldownLeft() > 0;
    settingsCard = h('section', { class: 'card waiting-card', 'aria-labelledby': 'wait-h' },
      h('div', { class: 'waiting-orb', 'aria-hidden': 'true' }, icon('bell')),
      h('h3', { id: 'wait-h', class: 'waiting-title' }, '等待房主开赛'),
      h('p', { class: 'hint center' }, '房主正在设置轮数和秒数。你的选择已就绪。'),
      h('div', { class: 'my-setup' }, ui.form.types.map((t) => h('span', { class: 'chip' }, TYPE_LABELS[t]))),
      h('button', {
        type: 'button', class: 'btn btn-ghost btn-block', disabled: cooling, 'data-nudge': '',
        onClick: () => { act({ type: 'nudge' }); ui.startNudgeCooldown(); },
      }, cooling ? `催促房主（${ui.nudgeCooldownLeft()} 秒后可用）` : '催促房主'));
  }

  const node = h('section', { class: 'screen', 'aria-labelledby': 'lobby-title' },
    top,
    h('div', { class: 'lobby-grid' }, rosterCard, settingsCard));
  return { node, dispose() {} };
}

// ---------- 3. 答题（选择题 / 文本题 / 抢答） ----------

export function quizScreen(view, act, ui) {
  const { round, question, settings, me } = view;
  const rk = `${round.no}`;
  const key = (k) => (ui.roundKey === rk ? k : null);
  if (ui.roundKey !== rk) { ui.roundKey = rk; ui.selected = null; ui.typed = ''; }

  const timer = countdown(question.remainMs, settings.seconds * 1000);
  const streak = settings.combo ? h('span', { class: `combo${me.combo >= 3 ? ' is-hot' : ''}` }, `连击 ×${1 + Math.floor(me.combo / 3)}`) : null;
  const top = quizTop(
    [{ text: `第 ${round.no} / ${round.total} 轮`, strong: true }, { text: `${settings.mode === 'buzz' ? '抢答' : '竞技'} · ${round.levelName}` }],
    [h('span', { class: 'stat' }, h('span', { class: 'stat-label' }, '得分'), h('span', { class: 'stat-val' }, String(me.score))), streak], ui);

  // 已退出的玩家不再计入「已提交 x / N」，也不占用别人的等待
  const active = view.roster.filter((p) => !p.left);
  const doneCount = active.filter((p) => p.answered).length;

  let body;
  if (question.buzzVerdict) {
    // 抢答模式：提交后服务器立刻回判，不用等整轮结束
    const ok = question.buzzVerdict === 'correct';
    body = h('article', { class: 'card question-card buzz-locked' },
      h('div', { class: `verdict ${ok ? 'is-ok' : 'is-bad'}` },
        h('span', { class: 'verdict-icon', 'aria-hidden': 'true' }, ok ? icon('check') : icon('close')),
        h('div', { class: 'verdict-text' },
          h('h2', { class: 'verdict-title' }, ok ? '抢答成功！' : '答错了'),
          h('p', { class: 'verdict-gain' }, ok ? `+${question.buzzPoints || 0} 分` : '本轮已锁定'))),
      h('p', { class: 'prompt' }, ok ? '等待本轮结算…' : '等其他人作答或时间到，下一题自动开始'),
      h('p', { class: 'count-line' }, h('strong', null, String(doneCount)), ` / ${active.length} 已完成`));
  } else if (question.submitted) {
    body = h('article', { class: 'card question-card waiting-answer' },
      h('div', { class: 'check-orb', 'aria-hidden': 'true' }, icon('check')),
      h('h2', { class: 'waiting-title' }, '已提交，等待其他选手'),
      h('p', { class: 'count-line' }, h('strong', null, String(doneCount)), ` / ${active.length} 已提交`),
      h('div', { class: 'submit-meter', style: `--frac: ${active.length ? doneCount / active.length : 0}` }, h('span')),
      h('ul', { class: 'submit-list' }, view.roster.map((p) => h('li', { class: `submit-item${p.answered ? ' is-done' : ''}${p.left ? ' is-left' : ''}` },
        avatar(p.name, 'avatar-sm'),
        h('span', { class: 'member-name' }, p.name),
        h('span', { class: 'submit-state' }, p.left ? '已退出' : p.answered ? '已提交' : '作答中…')))));
  } else if (settings.mode === 'buzz' && !question.display) {
    body = h('article', { class: 'card question-card buzz-card' },
      h('p', { class: 'buzz-note' }, '抢答：先按铃者答题，答错则判负'),
      h('button', { type: 'button', class: 'buzz-btn', 'aria-label': '按铃抢答', onClick: () => act({ type: 'buzz' }) },
        h('span', { class: 'buzz-icon', 'aria-hidden': 'true' }, icon('bell')),
        h('span', { class: 'buzz-text' }, '按铃抢答')));
  } else if (settings.mode === 'buzz' && question.buzzedBy && question.buzzedBy !== me.name) {
    body = h('article', { class: 'card question-card buzz-card' },
      h('p', { class: 'buzz-note' }, `${question.buzzedBy} 已按铃，本轮由他作答`),
      h('p', { class: 'hint center' }, '你被抢先了，等待结果'));
  } else {
    body = questionCard(question, round, act, ui, key, timer.node);
  }

  const node = h('section', { class: 'screen' },
    top,
    roundBar(round.no, round.total),
    body);

  // 键盘：A–D / 1–4 选择，Enter 提交
  const onKey = (e) => {
    if (question.submitted || !question.input || question.input.kind !== 'choice') return;
    // 正在别的输入框（比如公屏）里打字时不要抢键
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const idx = ['a', 'b', 'c', 'd', '1', '2', '3', '4'].indexOf(e.key.toLowerCase());
    if (idx >= 0) { ui.selected = ['A', 'B', 'C', 'D'][idx % 4]; ui.refresh(); }
    if (e.key === 'Enter' && ui.selected) act({ type: 'answer', answer: ui.selected });
  };
  document.addEventListener('keydown', onKey);
  return { node, dispose() { timer.dispose(); document.removeEventListener('keydown', onKey); } };
}

// 题干下方的提示语按题型给：原来按「题面是单词还是释义」判断，
// 于是「中译英选择」会显示“拼出这个单词”却给出四个选项
const PROMPTS = {
  mcq: '选出这个单词的正确中文释义',
  zh2en_mcq: '选出对应的英文单词',
  en2zh: '写出这个单词的中文释义',
  zh2en: '写出对应的英文单词',
  spell: '拼出这个单词',
};

// 拼写题首字母：真实网关给 "a…"，模拟给 "a____"；统一显示为主色首字母 + 省略号
function hintLetters(hint) {
  const given = String(hint).replace(/[_…\s.]+$/u, '');
  return h('p', { class: 'hint-letters', 'aria-label': `首字母 ${given}` },
    h('span', { class: 'hint-given' }, given),
    h('span', { class: 'hint-rest', 'aria-hidden': 'true' }, '…'));
}

function questionCard(question, round, act, ui, key, timerNode) {
  const display = question.display;
  const selected = key(ui.selected);
  const head = h('div', { class: 'question-head' },
    h('span', { class: 'type-tag' }, round.typeLabel),
    timerNode);

  const tip = PROMPTS[round.type] || '作答';
  const prompt = display.kind === 'word'
    ? [h('h2', { class: 'word' }, display.text), h('p', { class: 'phonetic' }, display.phonetic ? `/${display.phonetic}/` : ''),
      h('p', { class: 'prompt' }, tip)]
    : [h('p', { class: 'meaning' }, display.text),
      h('p', { class: 'prompt' }, question.input.hint ? `${tip}，首字母已给出` : tip)];

  if (question.input.kind === 'choice') {
    return h('article', { class: 'card question-card', 'aria-label': round.typeLabel },
      head, prompt,
      h('div', { class: 'options', role: 'radiogroup', 'aria-label': '选项' }, question.input.options.map((opt) => h('button', {
        type: 'button', class: `opt${selected === opt.key ? ' is-selected' : ''}`, role: 'radio', 'aria-checked': selected === opt.key,
        onClick: () => { ui.selected = opt.key; ui.refresh(); },
      }, h('kbd', null, opt.key), h('span', null, opt.text)))),
      h('div', { class: 'question-foot' },
        h('p', { class: 'hint' }, '键盘 A–D 或 1–4 作答，Enter 提交'),
        h('button', { type: 'button', class: 'btn btn-primary', disabled: !selected, onClick: () => act({ type: 'answer', answer: selected }) }, '提交')));
  }

  // 文本题
  const submitText = () => { const v = ui.typed.trim(); if (v) act({ type: 'answer', answer: v }); };
  return h('article', { class: 'card question-card', 'aria-label': round.typeLabel },
    head, prompt,
    question.input.hint ? hintLetters(question.input.hint) : null,
    h('label', { class: 'sr-only', for: 'answer-input' }, '你的答案'),
    h('input', {
      id: 'answer-input', class: 'input input-answer', type: 'text', autocomplete: 'off', spellcheck: 'false',
      placeholder: '输入答案', value: ui.typed, autofocus: true,
      onInput: (e) => { ui.typed = e.target.value; },
      onKeydown: (e) => { if (e.key === 'Enter') submitText(); },
    }),
    h('div', { class: 'question-foot' },
      h('p', { class: 'hint' }, 'Enter 提交；时间到未提交将判超时'),
      h('button', { type: 'button', class: 'btn btn-primary', onClick: submitText }, '提交')));
}

// ---------- 4. 结果 ----------

export function resultScreen(view, ui) {
  const r = view.result;
  const meta = [{ text: `第 ${view.round.no} / ${view.round.total} 轮 · 结果`, strong: true }];
  const top = quizTop(meta, [
    h('span', { class: 'stat' }, h('span', { class: 'stat-label' }, '得分'), h('span', { class: 'stat-val' }, String(view.me.score))),
    h('span', { class: `combo${r.combo >= 3 ? ' is-hot' : ''}` }, `连击 ×${1 + Math.floor(r.combo / 3)}`),
  ], ui);

  const verdict = {
    correct: { cls: 'is-ok', icon: icon('check'), title: '答对了！', gain: `+${r.gain} 分` },
    wrong: { cls: 'is-bad', icon: icon('close'), title: '答错了', gain: '+0 分' },
    timeout: { cls: 'is-bad', icon: icon('close'), title: '超时，连击中断', gain: '+0 分' },
    missed: { cls: 'is-missed', icon: icon('bolt'), title: '被抢先', gain: '+0 分' },
  }[r.verdict];

  // 每轮只播一次反馈：整屏重绘时 is-anim 不会再加，音效也不会重复
  const fresh = isFreshVerdict(`${view.round.no}:${r.verdict}`);
  if (fresh) {
    playVerdictSound(r.verdict);
    // 错题本只存本机；超时也算不会做，被抢先不算
    if (r.verdict === 'wrong' || r.verdict === 'timeout') {
      addMistake({
        word: r.word, phonetic: r.phonetic, senses: r.senses,
        yourAnswer: r.yourAnswer, type: view.round.type || '', verdict: r.verdict,
      });
    }
  }

  const countdownLeft = Math.ceil(r.pauseMs / 1000);
  const pauseFrac = h('span', { style: '--frac: 1' });
  const pauseBar = h('div', { class: 'pause-bar' }, pauseFrac);
  // 最后一轮不是「下一题」，而是「出最终榜单」
  const isLast = view.round.no >= view.round.total;
  const label = h('span', null,
    isLast ? '比赛结束 · ' : '下一题 ',
    h('strong', null, String(countdownLeft)),
    isLast ? ' 秒后公布最终结果' : ' 秒后开始');
  const started = Date.now();
  const id = setInterval(() => {
    const left = Math.max(0, r.pauseMs - (Date.now() - started));
    pauseFrac.style.setProperty('--frac', String(left / r.pauseMs || 0));
    label.querySelector('strong').textContent = String(Math.ceil(left / 1000));
  }, 200);

  const sensesNode = h('ul', { class: 'senses' }, r.senses.map((s) => h('li', null, h('span', { class: 'pos' }, s.pos), s.text)));

  const card = h('article', { class: `card result-card ${verdict.cls}${fresh ? ' is-anim' : ''}`, 'aria-labelledby': 'res-h' },
    h('div', { class: `verdict ${verdict.cls}` },
      h('span', { class: 'fx-ring', 'aria-hidden': 'true' }),
      h('span', { class: 'verdict-icon', 'aria-hidden': 'true' }, verdict.icon),
      h('div', { class: 'verdict-text' },
        h('h2', { id: 'res-h', class: 'verdict-title' }, verdict.title),
        h('p', { class: 'verdict-gain' }, verdict.gain)),
      r.gain > 0 ? h('span', { class: 'fx-gain', 'aria-hidden': 'true' }, `+${r.gain}`) : null),
    h('div', { class: 'answer-block' },
      h('p', { class: 'answer-label' }, '正确答案'),
      h('div', { class: 'answer-head' },
        h('span', { class: 'answer-word' }, r.word),
        h('span', { class: 'answer-ipa' }, r.phonetic ? `/${r.phonetic}/` : ''),
        h('button', { type: 'button', class: 'speak-btn', 'aria-label': '朗读单词', onClick: () => ui.speak(r.word) }, icon('volume'), '朗读')),
      sensesNode,
      h('p', { class: 'your-answer' }, '你的答案：', r.yourAnswer ? h('strong', null, r.yourAnswer) : h('span', { class: 'muted' }, '未作答'))),
    h('div', { class: 'next-countdown', role: 'status' }, label, pauseBar));

  const board = h('aside', { class: 'card board-card', 'aria-labelledby': 'board-h' },
    h('div', { class: 'card-head' }, h('h3', { id: 'board-h' }, '实时排行'), h('span', { class: 'hint-inline' }, `第 ${view.round.no} 轮后`)),
    h('ol', { class: 'board' }, view.scores.map((p, i) => h('li', {
      class: `board-row${i === 0 ? ' is-first' : ''}${p.id === view.me.id ? ' is-me' : ''}`,
    },
      h('span', { class: 'rank' }, String(i + 1)),
      avatar(p.name, 'avatar-sm'),
      h('span', { class: 'member-name' }, p.name),
      h('span', { class: `delta ${p.delta > 0 ? 'is-up' : p.status === 'timeout' ? 'is-down' : 'is-zero'}` },
        p.status === 'timeout' && p.delta === 0 ? '超时' : p.delta > 0 ? `+${p.delta}` : '0'),
      h('span', { class: 'board-score' }, String(p.score))))));

  const node = h('section', { class: `screen${fresh ? ` fx-${verdict.cls === 'is-ok' ? 'ok' : verdict.cls === 'is-bad' ? 'bad' : 'none'}` : ''}` },
    top, roundBar(view.round.no, view.round.total, view.round.no),
    h('div', { class: 'result-grid' }, card, board));
  return { node, dispose() { clearInterval(id); } };
}

// ---------- 5. 终局 ----------

export function finalScreen(view, act, ui) {
  const f = view.final;
  const ranking = f.ranking;

  // 并列名次：同分同名次，下一个名次跳号（1,1,3）
  const ranks = ranking.map((r, i) => (i > 0 && ranking[i - 1].score === r.score ? null : i + 1));
  for (let i = 1; i < ranks.length; i++) if (ranks[i] === null) ranks[i] = ranks[i - 1];

  // 槽位固定：2 = 左（银）、1 = 中（金）、3 = 右（铜）；i 是排序后的下标
  const order = [{ slot: 2, i: 1 }, { slot: 1, i: 0 }, { slot: 3, i: 2 }]
    .filter(({ i }) => ranking[i])
    .map(({ slot, i }) => ({ slot, i, row: ranking[i], rank: ranks[i] }));

  const pod = ({ slot, i, row, rank }) => h('div', { class: `pod pod-${slot}${row.id === view.me.id ? ' is-me' : ''}` },
    i === 0 ? h('span', { class: 'crown', 'aria-hidden': 'true' }, icon('crown', 'icon-fill')) : null,
    avatar(row.name),
    h('span', { class: 'pod-name' }, row.name,
      i > 0 && rank === ranks[i - 1] ? h('span', { class: 'pod-tie' }, '并列') : null),
    h('span', { class: 'pod-score' }, `${row.score} 分`),
    h('div', { class: 'pod-block' }, h('span', null, String(rank))));

  const table = h('table', { class: 'final-table' },
    h('thead', null, h('tr', null,
      h('th', { scope: 'col' }, '名次'), h('th', { scope: 'col' }, '选手'),
      h('th', { scope: 'col', class: 'num' }, '得分'), h('th', { scope: 'col', class: 'num' }, '答对'),
      h('th', { scope: 'col', class: 'num' }, '最高连击'))),
    h('tbody', null, ranking.map((r, i) => h('tr', { class: r.id === view.me.id ? 'is-me' : '' },
      h('td', null, String(ranks[i])),
      h('td', null, r.name, r.id === view.me.id ? ' ' : '', r.id === view.me.id ? h('span', { class: 'badge badge-me' }, '你') : null),
      h('td', { class: 'num' }, String(r.score)),
      h('td', { class: 'num' }, `${r.correct} / ${r.total}`),
      h('td', { class: 'num' }, `×${1 + Math.floor((r.maxCombo || 0) / 3)}`)))));

  const canvas = h('canvas', { class: 'confetti', 'aria-hidden': 'true' });
  const actions = f.isHost
    ? h('div', { class: 'final-actions' },
      h('button', { type: 'button', class: 'btn btn-primary', onClick: () => act({ type: 'restart', settings: { ...draft } }) }, '再来一局'),
      h('button', { type: 'button', class: 'btn btn-ghost btn-danger-ghost', onClick: () => act({ type: 'exit' }) }, '关闭房间'),
      h('p', { class: 'hint center' }, '再来一局：分数清零，选手保留；关闭房间后所有人回到加入页'))
    : h('div', { class: 'final-actions' },
      h('p', { class: 'waiting-line' }, h('span', { class: 'dot-pulse', 'aria-hidden': 'true' }), '等待房主再来一局或关闭房间'));

  // 并列冠军：同分的人一起写进标题
  const champions = ranking.filter((r, i) => ranks[i] === 1).map((r) => r.name);
  const myIndex = ranking.findIndex((r) => r.id === view.me.id);
  const myRank = myIndex >= 0 ? ranks[myIndex] : f.myRank;

  const node = h('section', { class: 'screen final', 'aria-labelledby': 'final-h' },
    canvas,
    h('header', { class: 'final-head' },
      h('p', { class: 'eyebrow' }, `比赛结束 · ${f.levelName || '擂台'}`),
      h('h2', { id: 'final-h', class: 'final-title' },
        h('span', { class: 'final-title-kicker' }, champions.length > 1 ? '并列冠军' : '擂台冠军'),
        h('span', { class: 'final-champion' }, champions.join('、'))),
      h('p', { class: 'final-sub' }, `你的名次：第 ${myRank} 名 · ${f.myScore} 分`)),
    h('div', { class: 'podium', 'aria-label': '前三名' }, order.map(pod)),
    h('article', { class: 'card final-board', 'aria-label': '完整榜单' },
      h('div', { class: 'card-head' }, h('h3', null, '完整榜单'), h('span', { class: 'hint-inline' }, '答对 = 答对题数 / 作答题数')),
      table),
    actions);
  return { node, dispose() {}, canvas };
}

/** 冠军撒花（canvas，无依赖）。减少动效时不播放。 */
export function celebrate(canvas) {
  if (!canvas || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  const ctx = canvas.getContext('2d');
  const colors = ['#d64a2e', '#e0a526', '#2f9a5b', '#3b7fd6', '#c0508f'];
  const parts = Array.from({ length: 140 }, () => ({
    x: Math.random() * canvas.width, y: -20 - Math.random() * canvas.height * 0.4,
    vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 4, s: 6 + Math.random() * 6,
    r: Math.random() * Math.PI, c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  const frame = (t) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    parts.forEach((p) => {
      p.x += p.vx; p.y += p.vy; p.r += 0.1;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      ctx.restore();
    });
    if (t - start < 4000) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  };
  requestAnimationFrame(frame);
}
