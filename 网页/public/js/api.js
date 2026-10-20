// 与网关通信的客户端。接口约定见 README（计划书「网关设计要点」）。
// 只使用相对路径：外面套 HTTPS 反代后无需改动。

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 响应按失败处理 */ }
  if (!res.ok || (data && data.error)) {
    const error = new Error((data && data.error) || `请求失败（${res.status}）`);
    error.status = res.status;
    throw error;
  }
  return data;
}

export function createApi() {
  return {
    /** 加入房间：{ name, level, types } → { sid } */
    join(form) {
      return request('POST', '/api/join', form);
    },

    /** 玩家动作：{ type: 'start'|'buzz'|'answer'|'nudge'|'exit'|'leave', ... } */
    act(sid, payload) {
      return request('POST', '/api/act', { sid, ...payload });
    },

    /** 统计数据：累计排行 + 最近对局 */
    stats() {
      return request('GET', '/api/stats');
    },

    /** 房间公屏发言：text 最多 120 字 */
    chat(sid, text) {
      return request('POST', '/api/chat', { sid, text });
    },

    /**
     * 订阅实时事件。view 为完整快照（重连后会先收到一份），notice 为瞬时提示；
     * chat 是房间里有人发言，chat-history 是重连时补的历史。
     * 返回取消订阅的函数。
     */
    subscribe(sid, { onView, onNotice, onChat, onChatHistory, onOpen, onError }) {
      const source = new EventSource(`/api/events?sid=${encodeURIComponent(sid)}`);
      source.addEventListener('view', (event) => onView(JSON.parse(event.data)));
      source.addEventListener('notice', (event) => onNotice(JSON.parse(event.data)));
      source.addEventListener('chat', (event) => onChat && onChat(JSON.parse(event.data)));
      source.addEventListener('chat-history', (event) => onChatHistory && onChatHistory(JSON.parse(event.data)));
      source.addEventListener('open', () => onOpen && onOpen());
      source.addEventListener('error', () => onError && onError());
      return () => source.close();
    },
  };
}
