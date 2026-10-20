// 房间公屏：右下角浮动的对话面板，所有房间成员共享。
// 只负责渲染与输入；发送走后端 /api/chat，消息通过 SSE 的 chat 事件推给所有人。
import { h, hueOf } from '../dom.js';
import { icon } from './icons.js';

let inst = null;

/**
 * 挂载一次。app.js 在启动时调用，之后通过返回的接口驱动。
 * onSend(text) 负责发出去；getMe() 返回自己的昵称（用来把自己的话靠右显示）。
 */
export function mountChat({ onSend, getMe }) {
  if (inst) return inst;

  const list = h('div', { class: 'chat-list', role: 'log', 'aria-live': 'polite' });
  const empty = h('p', { class: 'chat-empty' }, '还没有人发言，说点什么吧');
  const input = h('input', {
    class: 'chat-input', type: 'text', maxlength: 120, placeholder: '说点什么…',
    autocomplete: 'off', 'aria-label': '输入发言',
  });
  const sendBtn = h('button', { class: 'chat-send', type: 'submit' }, '发送');
  const form = h('form', { class: 'chat-form', onSubmit: (e) => { e.preventDefault(); doSend(); } }, input, sendBtn);

  const closeBtn = h('button', { class: 'chat-close', type: 'button', 'aria-label': '关闭房间公屏' }, icon('close'));
  const panel = h('section', { class: 'chat-panel', 'aria-label': '房间公屏' },
    h('header', { class: 'chat-head' },
      h('h3', { class: 'chat-title' }, '房间公屏'),
      h('span', { class: 'chat-hint' }, '所有人可见'),
      closeBtn),
    list,
    form);

  const btn = h('button', {
    type: 'button', class: 'chat-btn', 'aria-expanded': 'false', 'aria-label': '打开房间公屏',
  }, h('span', { class: 'chat-btn-icon', 'aria-hidden': 'true' }, icon('chat')),
    h('span', { class: 'chat-dot', 'aria-hidden': 'true' }));

  let open = false;
  let enabled = true;
  let unread = 0;

  const toggle = (next) => {
    open = next === undefined ? !open : !!next;
    panel.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', String(open));
    if (open) {
      unread = 0;
      btn.classList.remove('has-unread');
      scrollToEnd();
      if (enabled) input.focus();
    }
  };

  closeBtn.addEventListener('click', () => { toggle(false); btn.focus(); });
  btn.addEventListener('click', () => toggle());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { toggle(false); btn.focus(); } });

  function scrollToEnd() {
    list.scrollTop = list.scrollHeight;
  }

  function renderEmpty() {
    if (!list.childElementCount) list.append(empty);
  }

  function appendMsg(m, silent) {
    if (empty.parentNode) empty.remove();
    const mine = m.name === (getMe ? getMe() : null);
    const time = new Date(m.at || Date.now());
    const hh = String(time.getHours()).padStart(2, '0');
    const mm = String(time.getMinutes()).padStart(2, '0');
    const row = h('div', { class: `chat-msg${mine ? ' is-mine' : ''}${m.host ? ' is-host' : ''}` },
      h('div', { class: 'chat-msg-head' },
        h('span', { class: 'chat-who', style: `--hue: ${hueOf(m.name)}` }, m.name),
        m.host ? h('span', { class: 'chat-tag' }, '房主') : null,
        h('span', { class: 'chat-time' }, `${hh}:${mm}`)),
      h('p', { class: 'chat-text' }, m.text));
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.append(row);
    if (silent) return;
    if (open && atBottom) scrollToEnd();
    if (!open) {
      unread += 1;
      btn.classList.add('has-unread');
    }
  }

  function doSend() {
    if (!enabled) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    onSend(text);
  }

  document.body.append(panel, btn);
  renderEmpty();

  inst = {
    /** 历史消息（重连时服务器会补一份），不计入未读 */
    addHistory(messages) {
      list.replaceChildren();
      unread = 0;
      btn.classList.remove('has-unread');
      if (!messages || !messages.length) { renderEmpty(); return; }
      messages.forEach((m) => appendMsg(m, true));
      scrollToEnd();
    },
    add(m) { appendMsg(m); },
    /** 离开房间时清空面板 */
    clear() {
      list.replaceChildren();
      unread = 0;
      btn.classList.remove('has-unread');
      renderEmpty();
    },
    /** 答题进行中禁止发言（题目还没结束，发消息等于泄题） */
    setEnabled(v) {
      enabled = !!v;
      input.disabled = !enabled;
      sendBtn.disabled = !enabled;
      input.placeholder = enabled ? '说点什么…' : '答题进行中，暂不能发言';
      form.classList.toggle('is-locked', !enabled);
    },
    /** 不在房间里时整块隐藏（加入页没有会话，发了也没用） */
    setVisible(v) {
      btn.hidden = !v;
      if (!v && open) toggle(false);
      panel.hidden = !v;
    },
  };
  return inst;
}
