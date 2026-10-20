#pragma once
// 比赛核心状态与规则：玩家管理、出题、计分、排名、存档。
// 线程模型：大厅注册与答题由服务器读线程并发调用（内部加锁）；
// 出题 / 结算 / 排名由服务器主线程的赛程循环调用。
#include <string>
#include <vector>
#include <memory>
#include <mutex>
#include <condition_variable>
#include <random>
#include <set>
#include <atomic>

#include "word_bank.h"

// 每轮中某个玩家的作答状态
enum class AnsState { Waiting, Answered, Wrong, Timeout, Disconnected };

// 抢答模式的判分结果
enum class BuzzResult { Ignored, Correct, Wrong };

struct PlayerState {
    int id = -1;
    std::string name;
    std::string level = "cet4";
    std::vector<std::string> types; // 该玩家选择的题型
    bool lobbyDone = false;
    bool connected = true;
    // 幽灵槽位：没完成加入就断开、大厅中离开、或已被重连接替的旧槽位。
    // 不计入排名、成绩与存档；比赛中途掉线的玩家不会被标记（保留成绩）
    bool gone = false;

    // 累计成绩
    int score = 0;
    int correct = 0;
    int wrong = 0;
    int timeout = 0;
    int combo = 0;          // 当前连击（连续答对数）
    int bestCombo = 0;      // 历史最高连击
    long long totalLatencyMs = 0; // 答对题目累计用时，用于同分决胜

    // 本轮临时状态
    AnsState state = AnsState::Waiting;
    std::string answer;         // 玩家提交的答案
    std::string qtype;          // mcq / en2zh / zh2en / spell
    std::string qpayload;       // 发给客户端的题干字段
    std::string correctAnswer;  // 正确答案（判分用）
    std::string wordEnglish;    // 本题英文（展示用）
    std::string wordPhonetic;   // 本题音标（展示用）
    std::string wordChinese;    // 本题释义（展示用）
    int roundPoints = 0;
    bool roundCorrect = false;
    long long roundStartMs = 0;
    long long roundLatencyMs = 0;
};

class Game {
public:
    Game(const WordBank& bank, int rounds, int roundTimeSec)
        : bank_(bank), total_(rounds), roundTimeSec_(roundTimeSec) {
        rng_.seed(std::random_device{}());
    }

    // ---------- 大厅（由服务器读线程调用，线程安全） ----------
    int  addPlayer();
    bool setName(int id, const std::string& name);
    bool setLevel(int id, const std::string& level);
    bool setTypes(int id, const std::vector<std::string>& types);
    void finishLobby(int id);
    bool canStart() const;       // 至少 2 人且全部完成大厅注册
    bool nameTaken(int id, const std::string& name);       // 在线玩家是否已占用该昵称
    int  findDisconnectedByName(const std::string& name);  // 断线同名玩家 id（重连用）
    bool adoptPlayer(int newId, int oldId);                // 重连：迁移旧玩家状态
    int  electHost();            // 房主不在线时改选：最早加入且就绪的在线玩家；返回新房主 id，无变化返回 -1

    // ---------- 通用 ----------
    int  totalRounds() const { return total_.load(); }
    void setTotalRounds(int r) { total_.store(r); }
    int  roundTimeSec() const { return roundTimeSec_.load(); }
    void setRoundTimeSec(int s) { roundTimeSec_.store(s); }
    int  pauseSec() const { return pauseSec_.load(); }
    void setPauseSec(int s) { pauseSec_.store(s); }
    void setHostId(int id) { hostId_.store(id); }
    int  hostId() const { return hostId_.load(); }
    void resetForRematch();      // 再来一局：清零成绩与出题记录，保留玩家与大厅设置
    int  connectedCount() const; // 在线玩家数
    void setComboEnabled(bool b) { comboEnabled_.store(b); }
    bool comboEnabled() const { return comboEnabled_.load(); }
    void markDisconnected(int id);

    // ---------- 竞技模式（全场同一个单词，题型各自选择） ----------
    void startRound();           // 抽一个单词，每人按自己的题型出题，并重置状态
    void forceTimeoutRemaining();// 把仍等待的玩家判为超时
    void scoreRound();           // 结算本轮
    bool roundFinished() const;  // 所有在线玩家都已答/超时/断线（需持锁）

    // ---------- 抢答模式（同一道题，先答对者得分） ----------
    void startBuzzRound();       // 生成一道共享题目并重置状态
    BuzzResult recordBuzzAnswer(int id, int round, const std::string& text);
    void recordBuzzTimeout(int id, int round);
    void forceBuzzTimeout();     // 把仍等待的玩家判为超时（仅在无人答对时）
    bool buzzRoundFinished() const; // 有人答对 或 全部锁定/超时/断线（需持锁）
    bool buzzSolved() const { return buzzSolved_; }
    const std::string& buzzType() const { return buzzType_; }
    const std::string& buzzPayload() const { return buzzPayload_; }
    const std::string& buzzCorrect() const { return buzzCorrect_; }
    const std::string& buzzEnglish() const { return buzzEnglish_; }
    const std::string& buzzPhonetic() const { return buzzPhonetic_; }
    const std::string& buzzChinese() const { return buzzChinese_; }

    // ---------- 竞速模式答题（由服务器读线程调用，线程安全） ----------
    void recordAnswer(int id, int round, const std::string& text);
    void recordTimeout(int id, int round);

    // ---------- 结算与存档 ----------
    std::vector<int> ranking() const;         // 玩家 id，按名次排序（需持锁）
    std::string scoreboardString() const;     // "name=score,..."（需持锁）
    PlayerState* find(int id);                // 按 id（即下标）取玩家（需持锁）
    const PlayerState* find(int id) const;
    void saveMatch(const std::string& historyPath, const std::string& leaderboardPath);

    // ---------- 供服务器访问（读线程加锁用） ----------
    std::mutex& mutex() { return mtx_; }
    std::condition_variable& cv() { return cv_; }
    const std::vector<std::unique_ptr<PlayerState>>& players() const { return players_; }

private:
    struct QuestionParts {
        std::string type;
        std::string payload;
        std::string correctAnswer; // 判分用答案
        std::string english;       // 英文单词（展示用）
        std::string phonetic;      // 音标（展示用）
        std::string chinese;       // 中文释义（展示用）
    };

    WordBank bank_;
    std::atomic<int> total_;
    std::atomic<int> roundTimeSec_;
    std::atomic<bool> comboEnabled_{false}; // 连击倍率默认关闭
    std::atomic<int> pauseSec_{1};          // 每轮结果展示后的停顿秒数
    std::atomic<int> hostId_{0};            // 房主玩家 id（抢答题难度/题型取房主设置）
    int round_ = 0;
    std::vector<std::unique_ptr<PlayerState>> players_;
    std::mt19937 rng_;
    std::set<std::string> used_;  // 本场已出过的词，避免过早重复

    // 竞技模式当前轮的难度（取房主设置），用于计分基数
    std::string raceLevel_ = "cet4";

    // 抢答模式当前题目
    std::string buzzType_;
    std::string buzzPayload_;
    std::string buzzCorrect_;
    std::string buzzEnglish_;
    std::string buzzPhonetic_;
    std::string buzzChinese_;
    std::string buzzLevel_;
    bool buzzSolved_ = false;

    mutable std::mutex mtx_;
    std::condition_variable cv_;

    bool pickWord(const std::string& level, Word& out);  // 抽一个本场没出过的词；需持锁
    QuestionParts buildQuestion(const Word& w, const std::string& type); // 把词做成某种题型；需持锁
    QuestionParts makeQuestion(const std::string& level, const std::string& type);
    void applyQuestion(PlayerState& p, const QuestionParts& q);
    std::string hostLevelUnsafe() const;                 // 房主的难度（房主不存在时取第一位玩家）
    std::vector<std::string> hostTypesUnsafe() const;    // 房主的题型集合（为空或房主不存在时取全部题型）
    std::vector<std::string> pickSpellingDistractors(const Word& w, size_t n);
    bool checkAnswer(const std::string& qtype, const std::string& correctAnswer,
                     const std::string& answer) const;
    int  comboMultiplier(int combo) const;
    std::vector<int> rankingUnsafe() const;
};
