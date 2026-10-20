// 回归用例 B1、B2：对应测试反馈的两个问题。这些用例在修复之前应当失败。
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { SKIP, startFixture, Player, until, sleep } from './helpers.js';

// ---------------- P3：游戏服务器只监听本机 ----------------
// 网关以 127.0.0.1 启动 C++ 服务器，局域网或公网地址不应能直接连上游戏端口
const lanIp = Object.values(networkInterfaces()).flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;

describe('P3 游戏端口只接受本机连接', { skip: SKIP }, () => {
  let fx;
  let host;

  before(async () => {
    fx = await startFixture();
    host = await new Player(fx.base, '小明').join();
    await host.waitFor((v) => v.phase === 'lobby', 5000, '大厅');
  });

  after(() => {
    host?.close();
    fx?.stop();
  });

  const tryConnect = (ip, port) => new Promise((resolve) => {
    const s = net.createConnection({ host: ip, port });
    s.once('connect', () => { s.destroy(); resolve('connected'); });
    s.once('error', (e) => { s.destroy(); resolve(e.code); });
    setTimeout(() => { s.destroy(); resolve('timeout'); }, 2000);
  });

  test('本机回环地址可以连接', async () => {
    assert.equal(await tryConnect('127.0.0.1', fx.tcpPort), 'connected');
  });

  test('局域网地址不能直接连接游戏端口', { skip: lanIp ? false : '本机没有局域网 IPv4 地址' }, async () => {
    const r = await tryConnect(lanIp, fx.tcpPort);
    assert.notEqual(r, 'connected', `局域网地址 ${lanIp} 仍能直连游戏端口`);
  });
});

// ---------------- B1：催促时房主页面闪烁 ----------------
// 客人催促房主只应在房主页面弹出提示，不能让房主收到新的整屏视图（整屏重绘会让入场动画重播，看起来就是闪烁）
describe('B1 催促只弹提示，不重绘房主页面', { skip: SKIP }, () => {
  let fx;
  let host;
  let guest;

  before(async () => {
    fx = await startFixture();
    host = await new Player(fx.base, '小明').join();
    guest = await new Player(fx.base, '小红').join('cet4', ['mcq']);
    await host.waitFor((v) => v.phase === 'lobby' && v.roster.length === 2, 5000, '大厅两人');
  });

  after(() => {
    host?.close();
    guest?.close();
    fx?.stop();
  });

  test('客人催促后，房主收到提示，但没有新的视图', async () => {
    await sleep(300); // 等加入时的推送全部到达
    const viewsBefore = host.views.length;
    const noticesBefore = host.notices.length;
    await guest.act({ type: 'nudge' });
    await until(() => host.notices.some((n) => n.text.includes('催促')), 3000, '房主收到催促提示');
    assert.ok(host.notices.length > noticesBefore);
    await sleep(300);
    assert.equal(host.views.length, viewsBefore, `催促后房主多收到了 ${host.views.length - viewsBefore} 条整屏视图`);
  });
});

// ---------------- B3：大厅里关掉页面的人不再留在名单里 ----------------
describe('B3 大厅里关掉页面的人很快移出名单，房主无法带着他开赛', { skip: SKIP }, () => {
  let fx;
  let host;
  let guest;

  before(async () => {
    fx = await startFixture({ env: { GRACE_MS: '1500' } });
    host = await new Player(fx.base, '小明').join();
    guest = await new Player(fx.base, '小红').join('cet4', ['mcq']);
    await host.waitFor((v) => v.phase === 'lobby' && v.roster.length === 2, 5000, '大厅两人');
  });

  after(() => {
    host?.close();
    guest?.close();
    fx?.stop();
  });

  test('客人关闭页面（不再连接 SSE）后，名单只剩房主', async () => {
    const from = host.views.length;   // 只等关闭之后收到的视图（之前的视图里名单可能也只有一人）
    guest.dropStream();
    await host.waitFor((v) => v.phase === 'lobby' && v.roster.length === 1, 5000, '客人移出名单', from);
    await assert.rejects(host.act({ type: 'start', settings: { mode: 'race', rounds: 1, seconds: 2, combo: true, pause: 0 } }),
      (e) => e.status === 409);
  });
});

// ---------------- B2：竞技模式两人单词不同 ----------------
// 竞技模式同一轮所有人应面对同一个单词、同一个题型（都取房主设置）
describe('B2 竞技模式：同一轮两人看到同一个单词', { skip: SKIP }, () => {
  let fx;
  let host;
  let guest;

  before(async () => {
    fx = await startFixture();
    host = await new Player(fx.base, '小明').join('kaoyan', ['en2zh']);
    guest = await new Player(fx.base, '小红').join('kaoyan', ['zh2en']);
    await host.waitFor((v) => v.phase === 'lobby' && v.roster.length === 2, 5000, '大厅两人');
  });

  after(() => {
    host?.close();
    guest?.close();
    fx?.stop();
  });

  test('每一轮两人的结果回显单词相同，且题型统一取房主设置', async () => {
    await host.act({ type: 'start', settings: { mode: 'race', rounds: 3, seconds: 2, combo: true, pause: 0 } });
    for (let r = 1; r <= 3; r++) {
      const hr = await host.waitFor((v) => v.phase === 'result' && v.round.no === r, 10000, `房主第 ${r} 轮结果`);
      const gr = await guest.waitFor((v) => v.phase === 'result' && v.round.no === r, 10000, `客人第 ${r} 轮结果`);
      assert.equal(gr.result.word, hr.result.word, `第 ${r} 轮两人单词不同：${hr.result.word} / ${gr.result.word}`);
    }
    const hq = host.views.find((v) => v.phase === 'quiz' && v.round.no === 1);
    const gq = guest.views.find((v) => v.phase === 'quiz' && v.round.no === 1);
    assert.equal(hq.round.type, 'en2zh', '题型取房主（这里房主只选了英译中）');
    assert.equal(gq.round.type, hq.round.type, '客人即使只选了中译英，也必须跟房主同一题型');
  });
});
