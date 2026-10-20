// 入口：状态管理与屏幕切换。
// 流程：加入页 → POST /api/join 拿到 sid → 订阅 SSE → 每次收到 view 就按 phase 渲染对应屏幕。
// 调试：加 ?mock=1（可选 &role=guest）使用本地模拟后端，无需网关。
import { h, LEVEL_NAMES } from './dom.js';
import { icon } from './ui/icons.js';
import { createApi } from './api.js';
import { createMockApi } from './mock.js';
import { joinScreen, lobbyScreen, quizScreen, resultScreen, finalScreen, celebrate, draft } from './ui/screens.js';
import { openDrawer } from './ui/drawer.js';
import { mountChat } from './ui/chat.js';
import { resetVerdict, warmFeedbackSound, isMuted, toggleMuted, playNudgeSound } from './feedback.js';

const params = new URLSearchParams(location.search);
const isMock = params.get('mock') === '1';
const api = isMock ? createMockApi({ role: params.get('role') || 'host' }) : createApi();

const SESSION_KEY = 'vb.session';
const FORM_KEY = 'vb.form';
const root = document.getElementById('app');
const toastBox = document.getElementById('toasts');

// ---------- 本地存储（全部 try/catch，隐私模式下退化为内存） ----------
function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 忽略 */ }
}
function loadForm() {
  const saved = readJson(FORM_KEY, {});
  return {
    name: typeof saved.name === 'string' ? saved.name : '',
    level: LEVEL_NAMES[saved.level] ? saved.level : 'kaoyan',
    types: Array.isArray(saved.types) && saved.types.length ? saved.types : ['mcq', 'zh2en_mcq', 'en2zh', 'zh2en', 'spell'],
  };
}

// ---------- 状态 ----------
const state = {
  screen: 'join',     // join | lobby | quiz | result | final
  view: null,
  sid: null,
  online: true,
  busy: false,
  joinError: '',
  form: loadForm(),
  unsubscribe: null,
  draftReady: false,
  bootTimer: null,
  lastScreen: null,
  lastKey: null,      // 上一次渲染的「屏幕:轮次」，用于决定是否重播入场动画
  viewJson: null,     // 上一份视图的 JSON，内容没变就不重绘
};

let current = { dispose() {} };
let nudgeUntil = 0;
let nudgeTimer = null;
let chat = null;
// 结果页至少停留这么久再切到终局（防止「最后一题的对错」被结算页一闪而过）
const MIN_RESULT_MS = 1500;
let resultShownAt = 0;
let finalTimer = null;

// ---------- 交互辅助 ----------
function toast(text, kind = '') {
  const node = h('div', { class: `toast${kind ? ` is-${kind}` : ''}`, role: 'status' }, text);
  toastBox.append(node);
  setTimeout(() => node.remove(), 2600);
}

// 客人催促房主：普通 toast 太容易错过，改成顶部横幅 + 提示音，8 秒后自动收起
let alertBox = null;
let alertTimer = null;
function showNudge(text) {
  if (!alertBox) {
    alertBox = h('div', { class: 'alert', id: 'alert', role: 'alert' });
    document.body.append(alertBox);
  }
  alertBox.replaceChildren(
    h('span', { class: 'alert-icon', 'aria-hidden': 'true' }, icon('bell')),
    h('span', { class: 'alert-main' },
      h('strong', null, text),
      h('span', { class: 'alert-sub' }, '设置好轮数与秒数后，点下面的按钮开赛')),
  );
  alertBox.classList.add('is-on');
  playNudgeSound();
  clearTimeout(alertTimer);
  alertTimer = setTimeout(() => {
    alertBox.classList.remove('is-on');
    alertBox.replaceChildren();
  }, 8000);
}

function speak(word) {
  if (!('speechSynthesis' in window)) { toast('当前浏览器不支持朗读', 'bad'); return; }
  const u = new SpeechSynthesisUtterance(word);
  u.lang = 'en-US';
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

async function share() {
  const url = `${location.origin}${location.pathname}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('链接已复制，发给同学即可加入');
  } catch {
    toast(`复制失败，请手动复制：${url}`, 'bad');
  }
}

function startNudgeCooldown() {
  nudgeUntil = Date.now() + 30_000;
  clearInterval(nudgeTimer);
  // 只更新催促按钮的文字与可用状态，不整屏重绘（重绘会让等待页的呼吸动画每秒重新开始）
  const tick = () => {
    const left = Math.max(0, Math.ceil((nudgeUntil - Date.now()) / 1000));
    const btn = root.querySelector('[data-nudge]');
    if (btn) {
      btn.disabled = left > 0;
      btn.textContent = left > 0 ? `催促房主（${left} 秒后可用）` : '催促房主';
    }
    if (left === 0) { clearInterval(nudgeTimer); nudgeTimer = null; }
  };
  tick();
  nudgeTimer = setInterval(tick, 1000);
}

// 传给各屏幕的本地 UI 状态与操作（屏幕通过它刷新、朗读、分享等）
const ui = {
  selected: null,
  typed: '',
  roundKey: null,
  form: state.form,
  refresh: () => render(),
  share,
  speak,
  openStats: () => openDrawer(api),
  nudgeCooldownLeft: () => Math.max(0, Math.ceil((nudgeUntil - Date.now()) / 1000)),
  startNudgeCooldown,
};

// ---------- 加入 / 连接 ----------
async function onJoin() {
  const name = state.form.name.trim();
  if (!name) { state.joinError = '请输入昵称'; render(); return; }
  if (state.form.types.length === 0) { state.joinError = '至少选择一种题型'; render(); return; }

  state.busy = true;
  state.joinError = '';
  render();
  try {
    const { sid } = await api.join({ name, level: state.form.level, types: state.form.types });
    writeJson(FORM_KEY, state.form);
    if (!isMock) writeJson(SESSION_KEY, { sid, name });
    warmFeedbackSound(); // 借助这次点击预加载音效，第一次答题就不会延迟
    connect(sid);
  } catch (err) {
    state.busy = false;
    state.joinError = err.message;
    render();
  }
}

function connect(sid) {
  if (state.unsubscribe) state.unsubscribe();
  state.sid = sid;
  state.busy = false;
  state.draftReady = false;
  state.viewJson = null;
  clearTimeout(state.bootTimer);
  // 8 秒内没收到任何视图：会话大概率已失效（如服务器重启），回到加入页
  state.bootTimer = setTimeout(() => { if (!state.view) leaveToJoin('连接失败，请重新加入'); }, 8000);
  state.unsubscribe = api.subscribe(sid, {
    onOpen: () => { state.online = true; render(); },
    onError: () => { state.online = false; render(); },
    onView: (view) => { state.online = true; applyView(view); },
    onNotice: (n) => {
      if (n.kind === 'nudge') { showNudge(n.text); return; }
      toast(n.text, n.kind === 'error' ? 'bad' : '');
    },
    onChat: (m) => { if (chat) chat.add(m); },
    onChatHistory: (list) => { if (chat) chat.addHistory(list); },
  });
}

function applyView(view) {
  clearTimeout(state.bootTimer);
  if (view.phase === 'closed') { leaveToJoin('房间已关闭'); return; }
  // 最后一题：服务器可能紧接着就发 FINAL，先把本轮对错至少显示一会儿，别一闪而过
  if (finalTimer && view.phase !== 'final') { clearTimeout(finalTimer); finalTimer = null; }
  if (view.phase === 'final' && state.screen === 'result') {
    const wait = MIN_RESULT_MS - (Date.now() - resultShownAt);
    if (wait > 0) {
      clearTimeout(finalTimer);
      finalTimer = setTimeout(() => { finalTimer = null; applyView(view); }, wait);
      return;
    }
  }
  // 内容与上一份完全相同就不重绘（服务器会重复推送同一份视图），避免无谓的整屏刷新
  const json = JSON.stringify(view);
  if (json === state.viewJson) return;
  state.viewJson = json;
  if (view.phase === 'lobby' && !state.draftReady) {
    Object.assign(draft, view.settings);
    state.draftReady = true;
  }
  state.view = view;
  state.screen = view.phase;
  if (view.phase === 'result') resultShownAt = Date.now();
  render();
}

function leaveToJoin(message) {
  if (state.unsubscribe) state.unsubscribe();
  state.unsubscribe = null;
  clearTimeout(state.bootTimer);
  clearTimeout(finalTimer);
  finalTimer = null;
  state.sid = null;
  state.view = null;
  state.viewJson = null;
  state.screen = 'join';
  state.busy = false;
  state.online = true;
  writeJson(SESSION_KEY, null);
  if (chat) chat.clear();
  if (message) toast(message, 'bad');
  render();
}

async function act(payload) {
  try {
    await api.act(state.sid, payload);
  } catch (err) {
    toast(err.message, 'bad');
    return;
  }
  if (payload.type === 'leave') leaveToJoin('已离开房间');
}

// ---------- 渲染 ----------
function renderScreen() {
  const onName = (v) => { state.form.name = v; state.joinError = ''; };
  const onLevel = (v) => { state.form.level = v; render(); };
  const onType = (key) => {
    const set = new Set(state.form.types);
    if (set.has(key)) {
      if (set.size === 1) { state.joinError = '至少选择一种题型'; render(); return; }
      set.delete(key);
    } else {
      set.add(key);
    }
    state.form.types = [...set];
    ui.form = state.form;
    render();
  };
  switch (state.screen) {
    case 'lobby': return lobbyScreen(state.view, act, ui);
    case 'quiz': return quizScreen(state.view, act, ui);
    case 'result': return resultScreen(state.view, ui);
    case 'final': return finalScreen(state.view, act, ui);
    default:
      return joinScreen(state.form, {
        onName, onLevel, onType, onSubmit: onJoin, error: state.joinError, busy: state.busy,
      });
  }
}

function render() {
  // 供 CSS 使用：手机上让浮动按钮避开底部吸附按钮
  document.body.dataset.screen = state.screen;
  // 整屏重绘会丢失焦点（如答题时别人提交导致视图刷新），这里记下焦点与光标，重绘后恢复
  const active = document.activeElement;
  const focus = active && active.id ? { id: active.id, pos: active.selectionStart } : null;

  if (state.screen !== 'result') resetVerdict(); // 离开结果屏后，下一局同轮次可以重新播反馈
  if (chat) {
    chat.setVisible(state.screen !== 'join');       // 没进房间就别显示公屏
    chat.setEnabled(state.screen !== 'quiz');        // 答题中只读，避免泄题
  }

  current.dispose();
  const screen = renderScreen();
  current = screen;

  const nodes = [];
  if (!state.online && state.sid) nodes.push(h('div', { class: 'banner', role: 'status' }, '连接已断开，正在自动重连…'));

  // 战绩按钮：加入页和终局单独放一个（大厅、答题、结果的顶栏已自带）
  if (state.screen === 'join' || state.screen === 'final') {
    nodes.push(h('div', { class: 'page-tools' },
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => openDrawer(api) }, icon('chart'), '战绩')));
  }

  nodes.push(screen.node);
  // 同一屏同一轮内的刷新不重播入场动画（见 style.css 的 #app[data-same]）；换屏或换轮时正常播放
  const key = `${state.screen}:${state.view?.round?.no ?? ''}`;
  root.dataset.same = key === state.lastKey ? '1' : '0';
  root.replaceChildren(...nodes);

  if (focus) {
    const el = document.getElementById(focus.id);
    if (el) {
      el.focus();
      try { el.setSelectionRange(focus.pos, focus.pos); } catch { /* 非文本输入框不支持光标 */ }
    }
  }

  // 冠军撒花只在刚进入终局时播放一次
  if (state.screen === 'final' && state.lastScreen !== 'final') celebrate(screen.canvas);
  state.lastScreen = state.screen;
  state.lastKey = key;
}

// ---------- 启动 ----------
function mountMuteButton() {
  const render = (muted) => {
    muteBtn.replaceChildren(icon(muted ? 'mute' : 'volume'));
    muteBtn.classList.toggle('is-muted', muted);
    muteBtn.setAttribute('aria-pressed', String(muted));
    muteBtn.setAttribute('aria-label', muted ? '音效已关闭，点击打开' : '音效已打开，点击静音');
    muteBtn.title = muted ? '音效已关闭' : '音效已打开';
  };
  const muteBtn = h('button', { type: 'button', class: 'mute-btn' }, '');
  muteBtn.addEventListener('click', () => {
    const muted = toggleMuted();
    render(muted);
    if (!muted) playNudgeSound(); // 打开时响一声，确认音量正常
  });
  render(isMuted());
  document.body.append(muteBtn);
}

(function boot() {
  chat = mountChat({
    onSend: (text) => {
      if (!state.sid) return;
      api.chat(state.sid, text).catch((err) => toast(err.message, 'bad'));
    },
    getMe: () => state.view?.me?.name || state.form.name,
  });
  // 非模拟模式：如果上次的会话还在，就尝试恢复（SSE 会先推送一份快照）
  const saved = isMock ? null : readJson(SESSION_KEY, null);
  if (saved && saved.sid) {
    state.form.name = saved.name || state.form.name;
    connect(saved.sid);
  }
  mountMuteButton();
  render();
})();
