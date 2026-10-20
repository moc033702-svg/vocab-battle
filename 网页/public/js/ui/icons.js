// 线性图标（24×24 网格，描边 1.8）。用 h() 逐个生成 <svg>/<path>，不使用 innerHTML。
// 只能使用 dom.js 的 SVG_TAGS 里已有的标签：svg / path / circle / rect / g。
import { h } from '../dom.js';

const PATHS = {
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  volume: ['M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z', 'M15.5 9a4 4 0 0 1 0 6', 'M18 6.5a7.5 7.5 0 0 1 0 11'],
  mute: ['M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z', 'M16 9.5l5 5', 'M21 9.5l-5 5'],
  chat: ['M5 5h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 4v-4H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z'],
  bell: ['M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z', 'M10 20.5a2 2 0 0 0 4 0'],
  bolt: ['M13 3L5 13.5h6L10 21l8-10.5h-6z'],
  crown: ['M4 8l4 4 4-6 4 6 4-4-1.5 10h-13z'],
  chart: ['M5 20V11', 'M12 20V4', 'M19 20v-6'],
  link: ['M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1', 'M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1'],
  logout: ['M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3', 'M14 16l4-4-4-4', 'M18 12H9'],
};

/** icon('check') / icon('crown', 'icon-fill')；装饰性图标，默认对读屏隐藏 */
export function icon(name, cls = '') {
  return h('svg', {
    class: `icon ${cls}`.trim(), viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false',
    fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  }, (PATHS[name] || []).map((d) => h('path', { d })));
}
