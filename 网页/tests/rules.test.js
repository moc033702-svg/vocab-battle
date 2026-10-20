// 功能用例 I4、I6、I8、I10：抢答模式、开局参数与计时、断线重连、关闭房间后重新加入。
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP, startFixture, Player, until, sleep } from './helpers.js';

// ---------------- I4 抢答模式 ----------------
describe('I4 抢答模式：同一道题、至多一人答对', { skip: SKIP }, () => {
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
    host?.close(); guest?.close();
    fx?.stop();
  });

  test('两人看到同一道题，且设置回显为抢答', async () => {
    await host.act({ type: 'start', settings: { mode: 'buzz', rounds: 1, seconds: 3, combo: true, pause: 0 } });
    const hq = await host.waitFor((v) => v.phase === 'quiz', 8000, '房主题目');
    const gq = await guest.waitFor((v) => v.phase === 'quiz', 8000, '客人题目');
    assert.equal(hq.settings.mode, 'buzz');
    assert.equal(hq.question.display.text, gq.question.display.text, '抢答两人题目应相同');
    assert.equal(hq.round.type, gq.round.type);
    assert.deepEqual(hq.question.input.options?.map((o) => o.key), gq.question.input.options?.map((o) => o.key));
  });

  test('两人提交后，结果中至多一人答对，且每人都有结果', async () => {
    await host.act({ type: 'answer', answer: 'A' }).catch(() => {});
    await guest.act({ type: 'answer', answer: 'B' }).catch(() => {});
    const hr = await host.waitFor((v) => v.phase === 'result', 10000, '房主结果');
    const gr = await guest.waitFor((v) => v.phase === 'result', 10000, '客人结果');
    assert.ok(hr.result && gr.result);
    const verdicts = [hr.result.verdict, gr.result.verdict];
    assert.ok(verdicts.filter((v) => v === 'correct').length <= 1, `同一题不能两人都答对：${verdicts}`);
    for (const v of verdicts) assert.ok(['correct', 'wrong', 'missed', 'timeout'].includes(v), v);
  });
});

// ---------------- I6 开局参数与计时 ----------------
describe('I6 开局参数：轮数、超时、停顿实测', { skip: SKIP }, () => {
  let fx;
  let host;
  let guest;

  before(async () => {
    fx = await startFixture();
    host = await new Player(fx.base, '小明').join();
    guest = await new Player(fx.base, '小红').join();
    await host.waitFor((v) => v.phase === 'lobby' && v.roster.length === 2, 5000, '大厅两人');
  });

  after(() => {
    host?.close(); guest?.close();
    fx?.stop();
  });

  test('非法参数被拒绝（400），不会开始比赛', async () => {
    await assert.rejects(host.act({ type: 'start', settings: { rounds: 0 } }), (e) => e.status === 400);
    await assert.rejects(host.act({ type: 'start', settings: { seconds: 301 } }), (e) => e.status === 400);
    await assert.rejects(host.act({ type: 'start', settings: { pause: 11 } }), (e) => e.status === 400);
    await assert.rejects(host.act({ type: 'start', settings: { combo: 'yes' } }), (e) => e.status === 400);
    assert.equal(host.view.phase, 'lobby');
  });

  test('轮数、每题秒数、停顿、连击开关按设置生效', async () => {
    await host.act({ type: 'start', settings: { mode: 'race', rounds: 2, seconds: 2, combo: false, pause: 2 } });
    const q1 = await host.waitFor((v) => v.phase === 'quiz' && v.round.no === 1, 8000, '第 1 轮');
    assert.equal(q1.round.total, 2);
    assert.equal(q1.settings.combo, false);
    assert.equal(q1.settings.pause, 2);
    assert.ok(q1.question.remainMs <= 2000, `剩余时间应不超过 2 秒：${q1.question.remainMs}`);
  });

  test('不答题超时约 2 秒后结算，之后停顿约 2 秒才进入第 2 轮', async () => {
    const q1At = host.viewAt[host.views.findIndex((v) => v.phase === 'quiz' && v.round.no === 1)];
    const r1 = await host.waitFor((v) => v.phase === 'result' && v.round.no === 1, 8000, '第 1 轮结果');
    const r1At = host.viewAt[host.views.indexOf(r1)];
    assert.equal(r1.result.verdict, 'timeout');
    assert.equal(r1.result.pauseMs, 2000);
    const elapsed = r1At - q1At;
    assert.ok(elapsed >= 1700 && elapsed <= 3500, `超时应约 2 秒，实际 ${elapsed} ms`);

    const q2 = await host.waitFor((v) => v.phase === 'quiz' && v.round.no === 2, 8000, '第 2 轮');
    const q2At = host.viewAt[host.views.indexOf(q2)];
    const gap = q2At - r1At;
    assert.ok(gap >= 1700, `停顿应约 2 秒，实际 ${gap} ms`);
    assert.equal(q2.round.total, 2);
  });

  test('结束后进入终局', async () => {
    await host.waitFor((v) => v.phase === 'final', 20000, '终局');
  });
});

// ---------------- I8 断线重连 ----------------
describe('I8 断线重连：SSE 恢复快照，过期后凭昵称重新加入', { skip: SKIP }, () => {
  let fx;
  let host;
  let guest;

  before(async () => {
    // 宽限期缩短为 1.5 秒，便于测试过期
    fx = await startFixture({ env: { GRACE_MS: '1500' } });
    host = await new Player(fx.base, '小明').join();
    guest = await new Player(fx.base, '小红').join();
    await host.waitFor((v) => v.phase === 'lobby' && v.roster.length === 2, 5000, '大厅两人');
  });

  after(() => {
    host?.close(); guest?.close();
    fx?.stop();
  });

  test('宽限期内同一 sid 重新订阅，先收到当前快照', async () => {
    const before = guest.views.length;
    guest.dropStream();
    await sleep(200);
    await guest.subscribe();
    const snap = await guest.waitFor((v) => v.phase === 'lobby', 5000, '恢复后的快照', before);
    assert.equal(snap.me.name, '小红');
    assert.equal(snap.roster.length, 2);
  });

  test('会话过期后，旧 sid 收到 closed，对方名单移除该玩家', async () => {
    const oldSid = guest.sid;
    const from = host.views.length;   // 只看断开之后的视图
    guest.dropStream();
    await host.waitFor((v) => v.roster.length === 1, 6000, '过期后名单只剩房主', from);
    // 旧 sid 已失效：服务器返回 closed 视图
    const probe = new Player(fx.base, '探测');
    probe.sid = oldSid;
    await probe.subscribe();
    await probe.waitFor((v) => v.phase === 'closed', 5000, '旧会话 closed');
    probe.close();
  });

  test('过期后凭同一昵称重新加入，服务器按重连处理，名单恢复两人', async () => {
    const from = host.views.length;
    await guest.rejoin();
    const v = await host.waitFor((x) => x.phase === 'lobby' && x.roster.length === 2, 8000, '客人重新入列', from);
    assert.ok(v.roster.some((p) => p.name === '小红'));
    const g = await guest.waitFor((x) => x.phase === 'lobby', 5000, '重连后的客人视图');
    assert.equal(g.me.host, false);
  });
});

// ---------------- I10 关闭房间后重新加入 ----------------
describe('I10 房主关闭房间后，所有人回到加入页，可重新加入', { skip: SKIP }, () => {
  let fx;
  let host;
  let guest;

  before(async () => {
    fx = await startFixture();
    host = await new Player(fx.base, '小明').join();
    guest = await new Player(fx.base, '小红').join();
    await host.waitFor((v) => v.phase === 'lobby' && v.roster.length === 2, 5000, '大厅两人');
  });

  after(() => {
    host?.close(); guest?.close();
    fx?.stop();
  });

  test('比赛进行中不能关闭房间（409）', async () => {
    await host.act({ type: 'start', settings: { mode: 'race', rounds: 1, seconds: 2, combo: true, pause: 0 } });
    await host.waitFor((v) => v.phase === 'quiz', 8000, '开赛');
    await assert.rejects(host.act({ type: 'exit' }), (e) => e.status === 409);
    await host.waitFor((v) => v.phase === 'final', 15000, '终局');
  });

  test('房主关闭后，所有人收到 closed', async () => {
    await host.act({ type: 'exit' });
    await guest.waitFor((v) => v.phase === 'closed', 8000, '客人收到 closed');
    await host.waitFor((v) => v.phase === 'closed', 8000, '房主收到 closed');
  });

  test('服务器重启后，房主可以重新加入并再次成为房主', async () => {
    const again = await new Player(fx.base, '小明').join();
    const v = await again.waitFor((x) => x.phase === 'lobby', 8000, '重新加入的大厅');
    assert.equal(v.me.host, true, '重启后第一位加入者应为房主');
    assert.equal(v.roster.length, 1);
    again.close();
  });
});
