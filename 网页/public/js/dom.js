// 极简 DOM 工具。所有文本都走 textContent，玩家输入和词库内容不会被当作 HTML 解析。

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'circle', 'path', 'rect', 'g']);

/**
 * h('div', { class: 'card', onClick: fn }, child1, [child2, child3], 'text')
 * - class / 其它属性直接设置；on* 绑定事件；值为 null/false/undefined 的属性跳过
 * - 子节点可以是 Node、字符串、数字，或数组（会被展开）
 * - svg 相关标签自动使用 SVG 命名空间
 */
export function h(tag, props, ...children) {
  const node = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') {
      if (SVG_TAGS.has(tag)) node.setAttribute('class', value);
      else node.className = value;
    } else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** 首字母头像用的颜色（按名字哈希，同一人颜色稳定） */
export function hueOf(name) {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) % 360;
  return hash;
}

export function initialOf(name) {
  return Array.from(String(name || '?'))[0] || '?';
}

export const LEVEL_NAMES = {
  cet4: 'CET4 四级', cet6: 'CET6 六级', kaoyan: '考研', ielts: '雅思', toefl: '托福', gre: 'GRE 美国研究生',
};

export const TYPE_LABELS = {
  mcq: '英译中选择', zh2en_mcq: '中译英选择', en2zh: '英译中', zh2en: '中译英', spell: '拼写',
};

export const TYPE_DESC = {
  mcq: '看单词，从四个选项里选中文释义',
  zh2en_mcq: '看中文，从四个拼写相近的单词里选',
  en2zh: '看单词，手写中文释义（写出片段即可）',
  zh2en: '看中文，手写对应的英文单词',
  spell: '看释义和首字母提示，拼出完整单词',
};

export const LEVEL_BASE_SCORE = { cet4: 1, cet6: 2, kaoyan: 3, ielts: 4, toefl: 5, gre: 6 };
