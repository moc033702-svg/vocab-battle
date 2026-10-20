// 集成测试：启动真实的 C++ 服务器（经由网关），用 fetch 流式读取 SSE，扮演多名玩家跑完整局。
// 需要先构建：bin/vocab_battle.exe 与 data/words.csv 存在。每组用例使用独立的临时数据目录。
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP, startFixture, Player } from './helpers.js';

describe('整局对局（竞技模式）', { skip: SKIP }, () => {
  let fx;
  let host;
  let guest;

  before(async () => {
    fx = await startFixture();
    host = await new Player(fx.base, '小明').join();
    guest = await new Player(fx.base, '小红').join('cet4', ['mcq']);
  });

  after(() => {
    host?.close();
    guest?.close();
    fx?.stop();
  });

  test('I2 首位加入者是房主，名单两人都就绪', async () => {
    const v = await host.waitFor((x) => x.phase === 'lobby' && x.roster.length === 2, 10000, '大厅两人');
    const me = v.roster.find((p) => p.name === '小明');
    assert.equal(me.host, true);
    assert.equal(v.me.host, true);
    assert.equal(v.roster.find((p) => p.name === '小红').host, false);
    assert.ok(v.roster.every((p) => p.ready));
  });

  test('I1 重名与非法昵称被拒绝', async () => {
    await assert.rejects(new Player(fx.base, '小明').join(), (e) => e.status === 409);
    await assert.rejects(new Player(fx.base, 'a=b').join(), (e) => e.status === 400);
  });

  test('I2 客人收到的是客人视图，且不能开始比赛', async () => {
    const v = await guest.waitFor((x) => x.phase === 'lobby', 5000, '客人大厅');
    assert.equal(v.me.host, false);
    await assert.rejects(guest.act({ type: 'start', settings: {} }), (e) => e.status === 403);
  });

  test('I3 房主开赛（竞技、2 轮、2 秒、连击开）', async () => {
    await host.act({ type: 'start', settings: { mode: 'race', rounds: 2, seconds: 2, combo: true, pause: 1 } });
    const q = await host.waitFor((x) => x.phase === 'quiz', 10000, '第一题');
    assert.equal(q.round.no, 1);
    assert.equal(q.round.total, 2);
    assert.ok(['mcq', 'zh2en_mcq', 'en2zh', 'zh2en', 'spell'].includes(q.round.type));
    assert.ok(q.question.remainMs > 0 && q.question.remainMs <= 2000);
  });

  test('I3 两人拿到同一题型（取房主设置），题面结构与题型一致', async () => {
    const hq = await host.waitFor((x) => x.phase === 'quiz', 5000, '房主第一题');
    const q = await guest.waitFor((x) => x.phase === 'quiz', 5000, '客人第一题');
    assert.equal(q.round.type, hq.round.type, '同一轮两人的题型必须一致');
    assert.equal(q.question.input.kind, hq.question.input.kind);
    if (q.question.input.kind === 'choice') assert.equal(q.question.input.options.length, 4);
    assert.ok(['choice', 'text'].includes(q.question.input.kind));
  });

  test('I5 提交答案后显示已提交，名单计数 x/N', async () => {
    await host.act({ type: 'answer', answer: 'A' });
    const v = await host.waitFor((x) => x.phase === 'quiz' && x.question.submitted, 5000, '已提交');
    assert.equal(v.question.submitted, true);
    assert.equal(v.roster.find((p) => p.name === '小明').answered, true);
  });

  test('I7 不答题的一方到点自动超时，结果为 timeout', async () => {
    const r = await guest.waitFor((x) => x.phase === 'result' && x.round.no === 1, 8000, '客人第一轮结果');
    assert.equal(r.result.verdict, 'timeout');
    assert.equal(r.result.yourAnswer, null);
    assert.ok(r.result.word, '应回显英文单词');
    assert.ok(Array.isArray(r.result.senses));
  });

  test('I3 结果页含答案回显、实时排行榜', async () => {
    const r = await host.waitFor((x) => x.phase === 'result' && x.round.no === 1, 8000, '房主第一轮结果');
    assert.ok(['correct', 'wrong', 'timeout', 'missed'].includes(r.result.verdict));
    assert.equal(r.scores.length, 2);
    assert.ok(r.result.pauseMs === 1000);
  });

  test('I9 两轮结束后进入终局，榜单完整、冠军正确', async () => {
    const f = await host.waitFor((x) => x.phase === 'final', 20000, '终局');
    assert.equal(f.final.isHost, true);
    assert.equal(f.final.ranking.length, 2);
    assert.equal(f.final.champion.name, f.final.ranking[0].name);
    assert.equal(f.final.myRank, f.final.ranking.findIndex((r) => r.name === '小明') + 1);
    const g = await guest.waitFor((x) => x.phase === 'final', 5000, '客人终局');
    assert.equal(g.final.isHost, false);
  });

  test('I11 战绩接口与成绩文件一致', async () => {
    const res = await fetch(`${fx.base}/api/stats`);
    const s = await res.json();
    assert.equal(s.matches, 1);
    assert.equal(s.total.length, 2);
    assert.ok(s.recent[0].players === 2);
  });
});
