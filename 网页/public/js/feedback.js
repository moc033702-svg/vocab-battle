// 答题反馈：正确 / 错误 / 催促 三种音效，以及静音开关和「本轮只播一次」判定。
// 音效是 public/audio 下的 wav，想换音色直接覆盖文件即可，这里不用改。
const SRC = { correct: 'audio/correct.wav', wrong: 'audio/wrong.wav', nudge: 'audio/nudge.wav' };
const MUTE_KEY = 'vb.mute';
const cache = {};
let lastSig = null;
let muted = readMute();

function readMute() {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}

function audio(kind) {
  if (typeof Audio === 'undefined') return null;
  if (!cache[kind]) {
    const a = new Audio(SRC[kind]);
    a.preload = 'auto';
    a.volume = 0.6;
    cache[kind] = a;
  }
  return cache[kind];
}

/** 预加载，避免第一次播放有延迟。加入房间时调用一次即可。 */
export function warmFeedbackSound() {
  audio('correct');
  audio('wrong');
  audio('nudge');
}

export function isMuted() { return muted; }

export function setMuted(v) {
  muted = !!v;
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* 忽略 */ }
  return muted;
}

export function toggleMuted() { return setMuted(!muted); }

/** 离开结果屏时调用，下一局同轮次的结论可以重新播放。 */
export function resetVerdict() {
  lastSig = null;
}

/** 同一轮的同一个结论只算一次「新鲜的」，整屏重绘时不会重复播动画和音效。 */
export function isFreshVerdict(sig) {
  if (sig === lastSig) return false;
  lastSig = sig;
  return true;
}

function play(kind) {
  if (muted) return;
  const a = audio(kind);
  if (!a) return;
  try {
    a.currentTime = 0;
    const p = a.play();
    if (p && p.catch) p.catch(() => {}); // 浏览器拦截自动播放时静默失败
  } catch { /* 忽略 */ }
}

/** 只有 correct 播上行三连音，其余（答错 / 超时）播下行音。被抢先不算答错，不播。 */
export function playVerdictSound(verdict) {
  if (verdict === 'missed') return;
  play(verdict === 'correct' ? 'correct' : 'wrong');
}

/** 客人催促房主时的提示音。 */
export function playNudgeSound() {
  play('nudge');
}
