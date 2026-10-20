// 错题本：只存在浏览器本地（localStorage），不上传服务器。
// 一条记录 = 一个词 + 一种题型；同词同题型重复答错只累加次数，不重复堆行。
const KEY = 'vb.mistakes';
const LIMIT = 200;

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, LIMIT))); } catch { /* 隐私模式或超额，忽略 */ }
}

export function readMistakes() {
  return read();
}

export function clearMistakes() {
  try { localStorage.removeItem(KEY); } catch { /* 忽略 */ }
}

/**
 * 记一条错题。
 * entry: { word, phonetic, senses: [{pos,text}], yourAnswer, type, verdict }
 * 返回新的整条列表（调用方可用于刷新界面）。
 */
export function addMistake(entry) {
  const word = String(entry.word || '').trim();
  if (!word) return read();

  const list = read();
  const key = `${word}|${entry.type || ''}`;
  const at = new Date().toISOString();
  const i = list.findIndex((m) => `${m.word}|${m.type || ''}` === key);

  if (i >= 0) {
    list[i] = { ...list[i], count: (list[i].count || 1) + 1, at, yourAnswer: entry.yourAnswer || '' };
    const [hit] = list.splice(i, 1);
    list.unshift(hit);
  } else {
    list.unshift({
      word,
      phonetic: entry.phonetic || '',
      senses: Array.isArray(entry.senses) ? entry.senses : [],
      yourAnswer: entry.yourAnswer || '',
      type: entry.type || '',
      verdict: entry.verdict || 'wrong',
      count: 1,
      at,
    });
  }
  write(list);
  return list;
}
