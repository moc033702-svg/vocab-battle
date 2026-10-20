#include "game.h"

#include "protocol.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <fstream>
#include <filesystem>
#include <map>
#include <numeric>
#include <sstream>

namespace {

long long nowMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

} // namespace

// ---------------- 大厅 ----------------

int Game::addPlayer() {
    std::lock_guard<std::mutex> lk(mtx_);
    auto p = std::make_unique<PlayerState>();
    p->id = (int)players_.size();   // 约定 id == 下标
    p->connected = true;
    players_.push_back(std::move(p));
    return (int)players_.size() - 1;
}

bool Game::setName(int id, const std::string& name) {
    std::lock_guard<std::mutex> lk(mtx_);
    PlayerState* p = find(id);
    if (!p) return false;
    p->name = name;
    return true;
}

bool Game::setLevel(int id, const std::string& level) {
    if (!proto::validLevel(level)) return false;
    std::lock_guard<std::mutex> lk(mtx_);
    PlayerState* p = find(id);
    if (!p) return false;
    p->level = level;
    return true;
}

bool Game::setTypes(int id, const std::vector<std::string>& types) {
    std::vector<std::string> ok;
    for (const auto& t : types) if (proto::validType(t)) ok.push_back(t);
    if (ok.empty()) return false;
    std::lock_guard<std::mutex> lk(mtx_);
    PlayerState* p = find(id);
    if (!p) return false;
    p->types = std::move(ok);
    return true;
}

void Game::finishLobby(int id) {
    std::lock_guard<std::mutex> lk(mtx_);
    PlayerState* p = find(id);
    if (p) p->lobbyDone = true;
}

bool Game::canStart() const {
    std::lock_guard<std::mutex> lk(mtx_);
    int online = 0;
    for (const auto& up : players_) {
        if (!up->connected) continue;
        ++online;
        if (!up->lobbyDone) return false;
    }
    return online >= 2;
}

int Game::connectedCount() const {
    std::lock_guard<std::mutex> lk(mtx_);
    int n = 0;
    for (const auto& up : players_) if (up->connected) ++n;
    return n;
}

void Game::resetForRematch() {
    std::lock_guard<std::mutex> lk(mtx_);
    round_ = 0;
    used_.clear();
    buzzSolved_ = false;
    for (auto& up : players_) {
        PlayerState& p = *up;
        // 比赛结束后已经离线的人，在新一局开始前从名单中移除
        if (!p.connected) p.gone = true;
        p.score = p.correct = p.wrong = p.timeout = 0;
        p.combo = p.bestCombo = 0;
        p.totalLatencyMs = 0;
        p.state = p.connected ? AnsState::Waiting : AnsState::Disconnected;
        p.answer.clear();
        p.roundPoints = 0;
        p.roundCorrect = false;
    }
}

bool Game::nameTaken(int id, const std::string& name) {
    std::lock_guard<std::mutex> lk(mtx_);
    for (const auto& up : players_)
        if (up->id != id && up->connected && up->name == name) return true;
    return false;
}

int Game::findDisconnectedByName(const std::string& name) {
    std::lock_guard<std::mutex> lk(mtx_);
    for (const auto& up : players_)
        if (!up->connected && !up->gone && up->name == name) return up->id;
    return -1;
}

bool Game::adoptPlayer(int newId, int oldId) {
    std::lock_guard<std::mutex> lk(mtx_);
    PlayerState* n = find(newId);
    PlayerState* o = find(oldId);
    if (!n || !o) return false;
    n->name = o->name;
    n->level = o->level;
    n->types = o->types;
    n->lobbyDone = true;
    n->score = o->score;
    n->correct = o->correct;
    n->wrong = o->wrong;
    n->timeout = o->timeout;
    n->combo = o->combo;
    n->bestCombo = o->bestCombo;
    n->totalLatencyMs = o->totalLatencyMs;
    n->connected = true;
    // 本轮跳过（不阻塞当前轮），下一轮恢复正常
    n->state = AnsState::Timeout;
    n->answer.clear();
    n->roundPoints = 0;
    n->roundCorrect = false;
    n->roundStartMs = 0;
    n->roundLatencyMs = 0;
    o->connected = false;
    o->gone = true;             // 旧槽位已由新槽位接替，成绩已迁移，不能再计一次
    o->state = AnsState::Disconnected;
    o->name.clear();
    return true;
}

int Game::electHost() {
    std::lock_guard<std::mutex> lk(mtx_);
    const PlayerState* h = find(hostId_.load());
    if (h && h->connected) return -1;             // 房主仍在线，无需改选
    for (const auto& up : players_) {
        if (up->connected && up->lobbyDone) {
            hostId_.store(up->id);
            return up->id;
        }
    }
    return -1;                                    // 暂时没有符合条件的人，等下一位就绪者加入时再选
}

// ---------------- 赛程 ----------------

void Game::startRound() {
    std::lock_guard<std::mutex> lk(mtx_);
    ++round_;
    // 竞技模式：全场同一个单词、同一个题型。
    // 难度与题型都取房主设置，避免「选拼写的人」和「选选择题的人」在同一轮里难度不同、分数却一样。
    raceLevel_ = hostLevelUnsafe();
    const std::vector<std::string> types = hostTypesUnsafe();
    const std::string type =
        types[std::uniform_int_distribution<size_t>(0, types.size() - 1)(rng_)];
    Word w;
    const bool hasWord = pickWord(raceLevel_, w);
    for (auto& up : players_) {
        PlayerState& p = *up;
        if (!p.connected) { p.state = AnsState::Disconnected; continue; }
        applyQuestion(p, hasWord ? buildQuestion(w, type) : makeQuestion(raceLevel_, type));
        p.state = AnsState::Waiting;
        p.answer.clear();
        p.roundPoints = 0;
        p.roundCorrect = false;
        p.roundStartMs = nowMs();
        p.roundLatencyMs = 0;
    }
}

void Game::forceTimeoutRemaining() {
    std::lock_guard<std::mutex> lk(mtx_);
    for (auto& up : players_)
        if (up->connected && up->state == AnsState::Waiting)
            up->state = AnsState::Timeout;
}

void Game::scoreRound() {
    std::lock_guard<std::mutex> lk(mtx_);
    for (auto& up : players_) {
        PlayerState& p = *up;
        p.roundPoints = 0;
        p.roundCorrect = false;
        if (p.state == AnsState::Answered) {
            if (checkAnswer(p.qtype, p.correctAnswer, p.answer)) {
                ++p.combo;
                p.bestCombo = std::max(p.bestCombo, p.combo);
                p.roundPoints = proto::baseScore(raceLevel_) * comboMultiplier(p.combo);
                p.score += p.roundPoints;
                ++p.correct;
                p.roundCorrect = true;
                p.totalLatencyMs += p.roundLatencyMs;
            } else {
                ++p.wrong;
                p.combo = 0;
            }
        } else if (p.state == AnsState::Timeout) {
            ++p.timeout;
            p.combo = 0;
        }
        // Disconnected：本轮不参与计分
    }
}

// ---------------- 答题 ----------------

void Game::recordAnswer(int id, int round, const std::string& text) {
    std::lock_guard<std::mutex> lk(mtx_);
    PlayerState* p = find(id);
    if (!p) return;
    if (round != round_) return;                 // 上一轮的迟到答案，忽略
    if (p->state != AnsState::Waiting) return;   // 已作答 / 已超时
    p->state = AnsState::Answered;
    p->answer = text;
    p->roundLatencyMs = nowMs() - p->roundStartMs;
    cv_.notify_all();
}

void Game::recordTimeout(int id, int round) {
    std::lock_guard<std::mutex> lk(mtx_);
    PlayerState* p = find(id);
    if (!p) return;
    if (round != round_) return;
    if (p->state != AnsState::Waiting) return;
    p->state = AnsState::Timeout;
    cv_.notify_all();
}

void Game::markDisconnected(int id) {
    std::lock_guard<std::mutex> lk(mtx_);
    PlayerState* p = find(id);
    if (!p) return;
    p->connected = false;
    p->state = AnsState::Disconnected;
    // 没完成加入的连接，或不在比赛中（round_ == 0 即大厅）离开的人，不再计入名单
    if (!p->lobbyDone || round_ == 0) p->gone = true;
    cv_.notify_all();
}

bool Game::roundFinished() const {
    for (const auto& up : players_)
        if (up->connected && up->state == AnsState::Waiting) return false;
    return true;
}

// ---------------- 结算与存档 ----------------

std::vector<int> Game::rankingUnsafe() const {
    std::vector<int> ids;
    ids.reserve(players_.size());
    for (const auto& up : players_)
        if (!up->gone) ids.push_back(up->id);       // 幽灵槽位不参与排名
    std::sort(ids.begin(), ids.end(), [&](int a, int b) {
        const PlayerState& pa = *players_[a];
        const PlayerState& pb = *players_[b];
        if (pa.score != pb.score) return pa.score > pb.score;
        if (pa.correct != pb.correct) return pa.correct > pb.correct;
        return pa.totalLatencyMs < pb.totalLatencyMs; // 更快者靠前
    });
    return ids;
}

std::vector<int> Game::ranking() const {
    return rankingUnsafe();
}

std::string Game::scoreboardString() const {
    auto ids = rankingUnsafe();
    std::string s;
    for (size_t i = 0; i < ids.size(); ++i) {
        if (i) s += ",";
        s += players_[ids[i]]->name + "=" + std::to_string(players_[ids[i]]->score);
    }
    return s;
}

PlayerState* Game::find(int id) {
    if (id < 0 || id >= (int)players_.size()) return nullptr;
    return players_[id].get();
}

const PlayerState* Game::find(int id) const {
    if (id < 0 || id >= (int)players_.size()) return nullptr;
    return players_[id].get();
}

void Game::saveMatch(const std::string& historyPath, const std::string& leaderboardPath) {
    std::lock_guard<std::mutex> lk(mtx_);
    auto ids = rankingUnsafe();
    if (ids.empty()) return;

    std::string winner = players_[ids[0]]->name;

    // 时间戳
    std::time_t now = std::time(nullptr);
    char ts[32];
    std::tm tmbuf{};
#ifdef _WIN32
    localtime_s(&tmbuf, &now);
#else
    localtime_r(&now, &tmbuf);
#endif
    std::strftime(ts, sizeof(ts), "%Y-%m-%d %H:%M:%S", &tmbuf);

    // 写历史记录（追加一行）
    std::filesystem::path hp(historyPath);
    if (hp.has_parent_path()) std::filesystem::create_directories(hp.parent_path());
    {
        std::ofstream out(historyPath, std::ios::app);
        if (out) {
            out << ts << "|" << winner;
            for (int id : ids)
                out << "|" << players_[id]->name << "=" << players_[id]->score;
            out << "\n";
        }
    }

    // 更新累计排行榜
    struct LBRow { int wins = 0; long long total = 0; int matches = 0; int correct = 0; };
    std::map<std::string, LBRow> lb;

    std::ifstream in(leaderboardPath);
    if (in) {
        std::string l;
        std::getline(in, l); // 跳过表头
        while (std::getline(in, l)) {
            auto f = proto::split(proto::trim(l), ',');
            if (f.size() < 5) continue;
            LBRow r;
            r.wins    = std::atoi(f[1].c_str());
            r.total   = std::atoll(f[2].c_str());
            r.matches = std::atoi(f[3].c_str());
            r.correct = std::atoi(f[4].c_str());
            lb[f[0]] = r;
        }
    }

    for (size_t i = 0; i < ids.size(); ++i) {
        const PlayerState& p = *players_[ids[i]];
        LBRow& r = lb[p.name];
        r.total += p.score;
        r.matches += 1;
        r.correct += p.correct;
        if (i == 0) r.wins += 1;
    }

    std::filesystem::path lp(leaderboardPath);
    if (lp.has_parent_path()) std::filesystem::create_directories(lp.parent_path());

    std::vector<std::pair<std::string, LBRow>> vec(lb.begin(), lb.end());
    std::sort(vec.begin(), vec.end(), [](const auto& a, const auto& b) {
        if (a.second.wins != b.second.wins) return a.second.wins > b.second.wins;
        if (a.second.total != b.second.total) return a.second.total > b.second.total;
        return a.first < b.first;
    });

    std::ofstream out(leaderboardPath);
    if (out) {
        out << "name,wins,total_points,matches,correct\n";
        for (const auto& kv : vec)
            out << kv.first << "," << kv.second.wins << "," << kv.second.total
                << "," << kv.second.matches << "," << kv.second.correct << "\n";
    }
}

// ---------------- 出题与判分 ----------------

// 从难度词库里抽一个本场没出过的词（出完一轮再重置）。词库为空时返回 false。需持锁
bool Game::pickWord(const std::string& level, Word& out) {
    auto pool = bank_.wordsByLevel(level);
    if (pool.empty()) pool = bank_.all();
    if (pool.empty()) return false;

    // 优先抽本场没出过的词，出完一轮再重置
    std::vector<size_t> fresh;
    for (size_t i = 0; i < pool.size(); ++i)
        if (!used_.count(pool[i].english)) fresh.push_back(i);
    if (fresh.empty()) {
        used_.clear();
        fresh.resize(pool.size());
        std::iota(fresh.begin(), fresh.end(), 0);
    }
    out = pool[fresh[std::uniform_int_distribution<size_t>(0, fresh.size() - 1)(rng_)]];
    used_.insert(out.english);
    return true;
}

// 把一个词做成指定题型。mcq / zh2en_mcq 的干扰项从词库里取。需持锁
Game::QuestionParts Game::buildQuestion(const Word& w, const std::string& type) {
    QuestionParts q;
    q.type = type;
    q.english = w.english;
    q.phonetic = w.phonetic;
    q.chinese = w.display(); // 词典式（含词性），用于答案回显

    if (type == "mcq") {

        // 英译中选择：优先用词库「近义词释义」字段做干扰项，不足再随机补
        std::string correct = w.firstMeaning();
        std::vector<std::string> distract;
        std::set<std::string> seen{correct};
        std::vector<std::string> syn = w.synonyms;
        std::shuffle(syn.begin(), syn.end(), rng_);
        for (const auto& m : syn) {
            if (distract.size() == 3) break;
            if (seen.insert(m).second) distract.push_back(m);
        }
        if (distract.size() < 3) {
            std::vector<std::string> allMeanings;
            for (const auto& x : bank_.all()) {
                std::string m = x.firstMeaning();
                if (!m.empty()) allMeanings.push_back(m);
            }
            std::shuffle(allMeanings.begin(), allMeanings.end(), rng_);
            for (const auto& m : allMeanings) {
                if (distract.size() == 3) break;
                if (seen.insert(m).second) distract.push_back(m);
            }
        }
        while (distract.size() < 3) distract.push_back("（无）"); // 词库过小时兜底
        std::vector<std::string> opts = distract;
        opts.push_back(correct);
        std::shuffle(opts.begin(), opts.end(), rng_);

        const std::string letters = "ABCD";
        int correctIdx = -1;
        for (size_t i = 0; i < opts.size(); ++i)
            if (opts[i] == correct) correctIdx = (int)i;

        q.correctAnswer = std::string(1, letters[correctIdx]);
        q.payload = w.english + "|" + opts[0] + "|" + opts[1] + "|" + opts[2] + "|" + opts[3];
    } else if (type == "zh2en_mcq") {
        // 中译英选择：看中文，选英文；干扰项取拼写相近的词
        auto distract = pickSpellingDistractors(w, 3);
        std::vector<std::string> opts = distract;
        opts.push_back(w.english);
        std::shuffle(opts.begin(), opts.end(), rng_);
        const std::string letters = "ABCD";
        int correctIdx = 0;
        for (size_t i = 0; i < opts.size(); ++i)
            if (opts[i] == w.english) correctIdx = (int)i;
        q.correctAnswer = std::string(1, letters[correctIdx]);
        q.payload = w.chineseOnly() + "|" + opts[0] + "|" + opts[1] + "|" + opts[2] + "|" + opts[3];
    } else if (type == "en2zh") {
        q.correctAnswer = w.chineseOnly();
        q.payload = w.english;
    } else if (type == "zh2en") {
        q.correctAnswer = w.english;
        q.payload = w.chineseOnly();
    } else { // spell
        q.correctAnswer = w.english;
        q.payload = w.chineseOnly() + "|" + std::string(1, w.english[0]);
    }
    return q;
}

// 抢答模式与兜底：抽词并按题型出题。词库为空时给出占位题面（几乎不可能发生）。需持锁
Game::QuestionParts Game::makeQuestion(const std::string& level, const std::string& type) {
    Word w;
    if (pickWord(level, w)) return buildQuestion(w, type);
    QuestionParts q;
    q.type = type;
    q.payload = "?";
    q.correctAnswer = "?";
    return q;
}

// 把题目写入玩家本轮状态（需持锁）
void Game::applyQuestion(PlayerState& p, const QuestionParts& q) {
    p.qtype = q.type;
    p.qpayload = q.payload;
    p.correctAnswer = q.correctAnswer;
    p.wordEnglish = q.english;
    p.wordPhonetic = q.phonetic;
    p.wordChinese = q.chinese;
}

std::string Game::hostLevelUnsafe() const {
    const PlayerState* h = find(hostId_.load());
    if (!h && !players_.empty()) h = players_.front().get();
    return h ? h->level : std::string("cet4");
}

// 房主的题型集合。房主不存在或没设置过时退回全部题型，保证返回值一定非空
std::vector<std::string> Game::hostTypesUnsafe() const {
    const PlayerState* h = find(hostId_.load());
    if (!h && !players_.empty()) h = players_.front().get();
    if (!h || h->types.empty()) return proto::QTYPES();
    return h->types;
}


namespace {

// UTF-8 码点个数
size_t utf8Len(const std::string& s) {
    size_t n = 0;
    for (unsigned char c : s) if ((c & 0xC0) != 0x80) ++n;
    return n;
}

// 编辑距离（用于挑选形近词做干扰项）
int editDistance(const std::string& a, const std::string& b) {
    std::vector<int> prev(b.size() + 1), cur(b.size() + 1);
    for (size_t j = 0; j <= b.size(); ++j) prev[j] = (int)j;
    for (size_t i = 1; i <= a.size(); ++i) {
        cur[0] = (int)i;
        for (size_t j = 1; j <= b.size(); ++j) {
            int sub = prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1);
            cur[j] = std::min({prev[j] + 1, cur[j - 1] + 1, sub});
        }
        std::swap(prev, cur);
    }
    return prev[b.size()];
}

} // namespace

// 从词库中挑 n 个与 w 拼写相近的英文单词（编辑距离小者优先，同距离随机）
std::vector<std::string> Game::pickSpellingDistractors(const Word& w, size_t n) {
    std::vector<std::pair<int, std::string>> cand;
    for (const auto& x : bank_.all()) {
        if (x.english == w.english) continue;
        if (std::abs((int)x.english.size() - (int)w.english.size()) > 3) continue;
        cand.emplace_back(editDistance(proto::toLower(x.english), proto::toLower(w.english)), x.english);
    }
    std::shuffle(cand.begin(), cand.end(), rng_);
    std::stable_sort(cand.begin(), cand.end(),
                     [](const auto& a, const auto& b) { return a.first < b.first; });
    std::vector<std::string> out;
    std::set<std::string> seen{w.english};
    for (const auto& c : cand) {
        if (out.size() >= n) break;
        if (seen.insert(c.second).second) out.push_back(c.second);
    }
    while (out.size() < n) out.push_back(w.english + std::string(1, (char)('a' + out.size()))); // 兜底
    return out;
}

bool Game::checkAnswer(const std::string& qtype, const std::string& correctAnswer,
                       const std::string& answer) const {
    std::string a = proto::trim(answer);
    if (qtype == "mcq" || qtype == "zh2en_mcq") {
        // 支持 A/B/C/D 或 1/2/3/4
        if (a.size() == 1 && a[0] >= '1' && a[0] <= '4') a = std::string(1, (char)('A' + (a[0] - '1')));
        return proto::toUpper(a) == proto::toUpper(correctAnswer);
    }
    if (qtype == "en2zh") {
        // 一词多义：correctAnswer 形如 "跑/经营；跑步"，按 ';' 和 '/' 拆出每个释义逐一比对。
        // 完全一致算对；答案为某释义的一部分且至少两个字也算对（如「吸收」对「吸收（液体、气体等）」）。
        std::string na = proto::removeSpaces(a);
        if (na.empty()) return false;
        for (const auto& sense : proto::split(correctAnswer, ';'))
            for (const auto& part : proto::split(sense, '/')) {
                std::string np = proto::removeSpaces(proto::trim(part));
                if (na == np) return true;
                if (utf8Len(na) >= 2 && np.find(na) != std::string::npos) return true;
            }
        return false;
    }
    // zh2en / spell：比较英文，忽略大小写与首尾空白
    return proto::toLower(a) == proto::toLower(proto::trim(correctAnswer));
}

int Game::comboMultiplier(int combo) const {
    if (!comboEnabled_.load()) return 1; // 关闭连击倍率：每题只给基础分
    // 连击倍率：每连对 3 题 +1 倍，上限 3 倍
    return std::min(3, 1 + (combo - 1) / 3);
}

// ---------------- 抢答模式 ----------------

void Game::startBuzzRound() {
    std::lock_guard<std::mutex> lk(mtx_);
    ++round_;

    // 共享题目：难度与题型取房主设置（与竞技模式一致）
    buzzLevel_ = hostLevelUnsafe();
    const std::vector<std::string> types = hostTypesUnsafe();
    std::string type = types[std::uniform_int_distribution<size_t>(0, types.size() - 1)(rng_)];

    auto q = makeQuestion(buzzLevel_, type);
    buzzType_ = q.type;
    buzzPayload_ = q.payload;
    buzzCorrect_ = q.correctAnswer;
    buzzEnglish_ = q.english;
    buzzPhonetic_ = q.phonetic;
    buzzChinese_ = q.chinese;
    buzzSolved_ = false;

    for (auto& up : players_) {
        PlayerState& p = *up;
        if (!p.connected) { p.state = AnsState::Disconnected; continue; }
        p.state = AnsState::Waiting;
        p.answer.clear();
        p.roundPoints = 0;
        p.roundCorrect = false;
        p.roundStartMs = nowMs();
        p.roundLatencyMs = 0;
    }
}

BuzzResult Game::recordBuzzAnswer(int id, int round, const std::string& text) {
    std::lock_guard<std::mutex> lk(mtx_);
    PlayerState* p = find(id);
    if (!p) return BuzzResult::Ignored;
    if (round != round_ || buzzSolved_) return BuzzResult::Ignored;
    if (p->state != AnsState::Waiting) return BuzzResult::Ignored;

    p->roundLatencyMs = nowMs() - p->roundStartMs;
    if (checkAnswer(buzzType_, buzzCorrect_, text)) {
        p->state = AnsState::Answered;
        p->answer = text;
        ++p->combo;
        p->bestCombo = std::max(p->bestCombo, p->combo);
        p->roundPoints = proto::baseScore(buzzLevel_) * comboMultiplier(p->combo);
        p->score += p->roundPoints;
        ++p->correct;
        p->roundCorrect = true;
        p->totalLatencyMs += p->roundLatencyMs;
        buzzSolved_ = true;
        cv_.notify_all();
        return BuzzResult::Correct;
    } else {
        p->state = AnsState::Wrong; // 答错，本轮锁定
        p->answer = text;
        ++p->wrong;
        p->combo = 0;
        p->roundCorrect = false;
        p->roundPoints = 0;
        cv_.notify_all();
        return BuzzResult::Wrong;
    }
}

void Game::recordBuzzTimeout(int id, int round) {
    std::lock_guard<std::mutex> lk(mtx_);
    PlayerState* p = find(id);
    if (!p) return;
    if (round != round_ || buzzSolved_) return;
    if (p->state != AnsState::Waiting) return;
    p->state = AnsState::Timeout;
    ++p->timeout;
    p->combo = 0;
    cv_.notify_all();
}

void Game::forceBuzzTimeout() {
    std::lock_guard<std::mutex> lk(mtx_);
    if (buzzSolved_) return; // 已有人答对，剩下的视为错过（不重置连击）
    for (auto& up : players_)
        if (up->connected && up->state == AnsState::Waiting) {
            up->state = AnsState::Timeout;
            ++up->timeout;
            up->combo = 0;
        }
}

bool Game::buzzRoundFinished() const {
    if (buzzSolved_) return true;
    for (const auto& up : players_)
        if (up->connected && up->state == AnsState::Waiting) return false;
    return true;
}
