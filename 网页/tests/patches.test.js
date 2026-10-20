// 回归用例 P1、P2：对应 C++ 补丁。这些用例在补丁之前应当失败。
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP, startFixture, Player, until } from './helpers.js';

// ---------------- P1：幽灵玩家 ----------------
// 大厅里离开的人、重名被拒绝的连接（没有昵称）不应出现在成绩文件里
describe('P1 幽灵玩家不进入成绩文件', { skip: SKIP }, () => {
  let fx;
  let host;
  let stay;
  let leaver;

  before(async () => {
    fx = await startFixture();
    host = await new Player(fx.base, '小明').join();
    leaver = await new Player(fx.base, '小刚').join();
    // 重名加入会在服务器里留下一个没有昵称的槽位
    await assert.rejects(new Player(fx.base, '小明').join(), (e) => e.status === 409);
    await leaver.act({ type: 'leave' });
    stay = await new Player(fx.base, '小红').join();
    await host.waitFor((v) => v.phase === 'lobby' && v.roster.length === 2, 5000, '大厅两人');
  });

  after(() => {
    host?.close(); stay?.close();
    fx?.stop();
  });

  test('P1a 一局结束后，成绩文件只含真实玩家（无空名字、无离开的人）', async () => {
    await host.act({ type: 'start', settings: { mode: 'race', rounds: 1, seconds: 2, combo: true, pause: 0 } });
    await host.waitFor((v) => v.phase === 'final', 15000, '终局');
    const history = await until(() => {
      const lines = fx.csv('history.csv');
      return lines.length ? lines : null;
    }, 5000, '写入 history.csv');
    const names = history[history.length - 1].split('|').slice(2).map((e) => e.slice(0, e.lastIndexOf('=')));
    assert.deepEqual(names.filter((n) => !n), [], `history 含空名字：${history[history.length - 1]}`);
    assert.ok(!names.includes('小刚'), `history 含已离开的玩家：${history[history.length - 1]}`);
    assert.deepEqual(names.sort(), ['小明', '小红'].sort());
  });

  test('P1b 排行榜文件没有空名字行，也没有已离开的玩家', () => {
    const rows = fx.csv('leaderboard.csv').slice(1).map((l) => l.split(',')[0]);
    assert.deepEqual(rows.filter((n) => !n), [], '排行榜含空名字行');
    assert.ok(!rows.includes('小刚'), '排行榜含已离开的玩家');
  });
});

// ---------------- P2：房主掉线后换房主 ----------------
describe('P2 房主离开后仍可开赛', { skip: SKIP }, () => {
  let fx;
  let host;
  let b;
  let c;

  before(async () => {
    fx = await startFixture();
    host = await new Player(fx.base, '小明').join();
    b = await new Player(fx.base, '小红').join();
    c = await new Player(fx.base, '小刚').join();
    await host.waitFor((v) => v.phase === 'lobby' && v.roster.length === 3, 5000, '大厅三人');
  });

  after(() => {
    host?.close(); b?.close(); c?.close();
    fx?.stop();
  });

  test('P2a 房主离开后，最早加入且就绪的玩家成为房主', async () => {
    await host.act({ type: 'leave' });
    const v = await b.waitFor((x) => x.phase === 'lobby' && x.me.host === true, 5000, '小红成为房主');
    assert.equal(v.roster.find((p) => p.name === '小红').host, true);
    assert.equal(v.roster.find((p) => p.name === '小刚').host, false);
    await c.waitFor((x) => x.phase === 'lobby' && x.roster.find((p) => p.name === '小红')?.host === true, 5000, '小刚看到新房主');
  });

  test('P2b 新房主可以开赛', async () => {
    await b.act({ type: 'start', settings: { mode: 'race', rounds: 1, seconds: 2, combo: true, pause: 0 } });
    const q = await c.waitFor((x) => x.phase === 'quiz', 8000, '开赛后的第一题');
    assert.equal(q.round.no, 1);
  });
});
