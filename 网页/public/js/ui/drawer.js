// 战绩抽屉：从右侧滑出，任何时刻都能打开。关闭方式：关闭按钮、点遮罩、Esc，关闭后焦点回到触发按钮。
import { h, TYPE_LABELS } from '../dom.js';
import { readMistakes, clearMistakes } from '../mistakes.js';
import { icon } from './icons.js';

let open = null; // { layer, onKey, returnFocus }

export async function openDrawer(api) {
  if (open) return;
  const returnFocus = document.activeElement;

  const body = h('div', { class: 'drawer-body' }, h('p', { class: 'load-line' }, '正在加载战绩…'));
  const closeBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': '关闭战绩', onClick: () => closeDrawer() }, icon('close'));
  const scrim = h('div', { class: 'drawer-scrim', 'aria-hidden': 'true', onClick: () => closeDrawer() });
  const panel = h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'stats-h' },
    h('header', { class: 'drawer-head' },
      h('div', null,
        h('p', { class: 'eyebrow' }, '累计战绩 · 全部对局'),
        h('h2', { id: 'stats-h', class: 'topbar-title' }, '战绩')),
      closeBtn),
    body);
  const layer = h('div', { class: 'drawer-layer' }, scrim, panel);
  document.body.append(layer);

  const onKey = (e) => { if (e.key === 'Escape') closeDrawer(); };
  document.addEventListener('keydown', onKey);
  open = { layer, onKey, returnFocus };
  closeBtn.focus();

  try {
    const stats = await api.stats();
    if (!open || open.layer !== layer) return; // 已经关闭
    body.replaceChildren(...renderStats(stats));
  } catch (err) {
    if (!open || open.layer !== layer) return;
    body.replaceChildren(h('p', { class: 'error-line' }, `战绩加载失败：${err.message}`));
  }
}

export function closeDrawer() {
  if (!open) return;
  document.removeEventListener('keydown', open.onKey);
  open.layer.remove();
  if (open.returnFocus && open.returnFocus.focus) open.returnFocus.focus();
  open = null;
}

export function isDrawerOpen() {
  return open !== null;
}

function renderStats(stats) {  const total = stats.total || [];
  const recent = stats.recent || [];
  const matches = recent.length;
  const top = total.length ? Math.max(...total.map((p) => p.points)) : 0;

  return [
    h('div', { class: 'summary-row' },
      h('div', { class: 'summary' }, h('span', { class: 'summary-val' }, String(stats.matches ?? matches)), h('span', { class: 'summary-label' }, '对局')),
      h('div', { class: 'summary' }, h('span', { class: 'summary-val' }, String(total.length)), h('span', { class: 'summary-label' }, '选手')),
      h('div', { class: 'summary' }, h('span', { class: 'summary-val' }, String(top)), h('span', { class: 'summary-label' }, '最高总分'))),
    mistakesSection(),
    h('section', { 'aria-labelledby': 'total-h' },
      h('h3', { id: 'total-h', class: 'section-title' }, '累计排行'),
      total.length === 0
        ? h('p', { class: 'muted-line' }, '还没有对局记录')
        : h('table', { class: 'final-table compact' },
          h('thead', null, h('tr', null,
            h('th', { scope: 'col' }, '#'), h('th', { scope: 'col' }, '选手'),
            h('th', { scope: 'col', class: 'num' }, '胜场'), h('th', { scope: 'col', class: 'num' }, '总分'),
            h('th', { scope: 'col', class: 'num' }, '场次'), h('th', { scope: 'col', class: 'num' }, '答对题数'))),
          h('tbody', null, total.map((p) => h('tr', null,
            h('td', null, String(p.rank)), h('td', null, p.name),
            h('td', { class: 'num' }, String(p.wins)), h('td', { class: 'num' }, String(p.points)),
            h('td', { class: 'num' }, String(p.matches)),
            // 服务器只累计答对题数，没有「答题总数」，所以这里给累计答对数而不是百分比
            h('td', { class: 'num' }, String(p.correct ?? 0))))))),
    h('section', { 'aria-labelledby': 'recent-h' },
      h('h3', { id: 'recent-h', class: 'section-title' }, '最近对局'),
      recent.length === 0
        ? h('p', { class: 'muted-line' }, '还没有对局记录')
        : h('ul', { class: 'match-list' }, recent.map((m) => h('li', { class: 'match' },
          h('div', { class: 'match-main' },
            h('span', { class: 'match-title' }, m.title),
            h('span', { class: 'match-meta' }, `${m.at} · ${m.players} 人`)),
          h('span', { class: 'badge badge-host' }, `冠军 ${m.champion} ${m.score}`))))),
  ];
}

// 错题本（只存在本机浏览器）。清空后就地整块替换，不重载整个抽屉
function mistakesSection() {
  const list = readMistakes();
  const shown = list.slice(0, 10);
  const sec = h('section', { 'aria-labelledby': 'mistakes-h' },
    h('div', { class: 'section-head' },
      h('h3', { id: 'mistakes-h', class: 'section-title' }, '错题本 ',
        h('span', { class: 'hint-inline' }, list.length ? `共 ${list.length} 条 · 只存在本机` : '只存在本机')),
      list.length ? h('button', {
        type: 'button', class: 'btn btn-ghost btn-sm',
        onClick: () => {
          if (!confirm('清空本机的错题记录？')) return;
          clearMistakes();
          sec.replaceWith(mistakesSection());
        },
      }, '清空') : null),
    list.length === 0
      ? h('p', { class: 'muted-line' }, '还没有错题。答错或超时的词会自动记在这里，方便课后复习。')
      : h('ul', { class: 'mistake-list' }, shown.map((m) => h('li', { class: 'mistake' },
        h('div', { class: 'mistake-main' },
          h('span', { class: 'mistake-word' }, m.word,
            m.phonetic ? h('span', { class: 'mistake-ipa' }, `/${m.phonetic}/`) : null),
          h('span', { class: 'mistake-sense' }, m.senses?.[0] ? `${m.senses[0].pos} ${m.senses[0].text}` : '')),
        h('span', { class: 'mistake-meta' },
          TYPE_LABELS[m.type] ? h('span', { class: 'tag-mini' }, TYPE_LABELS[m.type]) : null,
          m.count > 1 ? h('span', { class: 'tag-mini is-count' }, `错 ${m.count} 次`) : null)))),
    list.length > shown.length ? h('p', { class: 'muted-line' }, `只显示最近 ${shown.length} 条`) : null);
  return sec;
}
