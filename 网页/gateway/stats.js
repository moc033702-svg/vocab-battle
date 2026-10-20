// 读取服务器写出的 data/leaderboard.csv 与 data/history.csv，生成战绩抽屉需要的数据。
import { readFile } from 'node:fs/promises';
import path from 'node:path';

async function readLines(file) {
  try {
    return (await readFile(file, 'utf8')).split(/\r?\n/).filter((l) => l.trim());
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// leaderboard.csv 表头：name,wins,total_points,matches,correct
// history.csv 每行：时间|冠军|名字=分数|名字=分数...（按名次排列）
export async function readStats(dataDir) {
  const board = await readLines(path.join(dataDir, 'leaderboard.csv'));
  const history = await readLines(path.join(dataDir, 'history.csv'));

  const total = board.slice(1)
    .map((line) => line.split(','))
    .filter((f) => f.length >= 5 && f[0])
    .map((f, i) => ({
      rank: i + 1,
      name: f[0],
      wins: Number(f[1]) || 0,
      points: Number(f[2]) || 0,
      matches: Number(f[3]) || 0,
      // 累计答对题数。服务器没记录每人的答题总数，算不出百分比，前端就显示这个数量
      correct: Number(f[4]) || 0,
    }));

  const recent = history.slice(-10).reverse().map((line) => {
    const [at, champion, ...entries] = line.split('|');
    const players = entries
      .map((e) => e.lastIndexOf('='))
      .filter((i) => i > 0);
    const champEntry = entries.find((e) => e.slice(0, e.lastIndexOf('=')) === champion);
    return {
      title: '一局比赛',
      at,
      players: players.length,
      champion,
      score: champEntry ? Number(champEntry.slice(champEntry.lastIndexOf('=') + 1)) || 0 : 0,
    };
  });

  return { matches: history.length, total, recent };
}
