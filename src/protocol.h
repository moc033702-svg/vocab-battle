#pragma once
// 共享的协议常量与字符串工具，供服务端、客户端、词库模块共同使用。
#include <string>
#include <vector>
#include <sstream>
#include <cctype>
#include <algorithm>
#include <utility>

namespace proto {

// ---------------- 字符串工具 ----------------

// 去掉首尾空白
inline std::string trim(const std::string& s) {
    size_t b = s.find_first_not_of(" \t\r\n");
    if (b == std::string::npos) return "";
    size_t e = s.find_last_not_of(" \t\r\n");
    return s.substr(b, e - b + 1);
}

// 去掉所有空白字符（中文释义比对时更宽容）
inline std::string removeSpaces(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) if (!std::isspace((unsigned char)c)) out.push_back(c);
    return out;
}

// 按分隔符切分字符串
inline std::vector<std::string> split(const std::string& s, char delim) {
    std::vector<std::string> out;
    std::string cur;
    std::stringstream ss(s);
    while (std::getline(ss, cur, delim)) out.push_back(cur);
    if (!s.empty() && s.back() == delim) out.push_back("");
    return out;
}

// 在第一个分隔符处切成两段
inline std::pair<std::string, std::string> splitFirst(const std::string& s, char delim) {
    size_t p = s.find(delim);
    if (p == std::string::npos) return {s, ""};
    return {s.substr(0, p), s.substr(p + 1)};
}

inline std::string toLower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return (char)std::tolower(c); });
    return s;
}

inline std::string toUpper(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return (char)std::toupper(c); });
    return s;
}

// 把一行消息拆成 {命令, 其余内容}（其余已 trim）
inline std::pair<std::string, std::string> splitCmd(const std::string& line) {
    std::string t = trim(line);
    size_t sp = t.find(' ');
    if (sp == std::string::npos) return {t, ""};
    return {t.substr(0, sp), trim(t.substr(sp + 1))};
}

// ---------------- 难度等级 ----------------

inline const std::vector<std::string>& LEVELS() {
    static const std::vector<std::string> v = {"cet4", "cet6", "kaoyan", "ielts", "toefl", "gre"};
    return v;
}

inline std::string levelName(const std::string& l) {
    if (l == "cet4")   return "CET4 四级";
    if (l == "cet6")   return "CET6 六级";
    if (l == "kaoyan") return "考研";
    if (l == "ielts")  return "雅思";
    if (l == "toefl")  return "托福";
    if (l == "gre")    return "GRE 美国研究生";
    return l;
}

// 难度基础分：越难分值越高，答对收益越大
inline int baseScore(const std::string& l) {
    if (l == "cet4")   return 1;
    if (l == "cet6")   return 2;
    if (l == "kaoyan") return 3;
    if (l == "ielts")  return 4;
    if (l == "toefl")  return 5;
    if (l == "gre")    return 6;
    return 1;
}

inline bool validLevel(const std::string& l) {
    for (const auto& x : LEVELS()) if (x == l) return true;
    return false;
}

// ---------------- 题型 ----------------

inline const std::vector<std::string>& QTYPES() {
    static const std::vector<std::string> v = {"mcq", "zh2en_mcq", "en2zh", "zh2en", "spell"};
    return v;
}

inline std::string typeName(const std::string& t) {
    if (t == "mcq")       return "英译中选择";
    if (t == "zh2en_mcq") return "中译英选择";
    if (t == "en2zh")     return "英译中";
    if (t == "zh2en") return "中译英";
    if (t == "spell") return "拼写";
    return t;
}

inline bool validType(const std::string& t) {
    for (const auto& x : QTYPES()) if (x == t) return true;
    return false;
}

// ---------------- 协议消息关键字 ----------------

// 客户端 -> 服务器
inline const std::string JOIN    = "JOIN";
inline const std::string LEVEL   = "LEVEL";
inline const std::string TYPES   = "TYPES";
inline const std::string START   = "START";
inline const std::string WAIT    = "WAIT";
inline const std::string ANSWER  = "ANSWER";
inline const std::string TIMEOUT = "TIMEOUT";
inline const std::string QUIT    = "QUIT";
inline const std::string SETTINGS = "SETTINGS";
inline const std::string NUDGE   = "NUDGE";   // 客人催促房主开赛
inline const std::string EXIT    = "EXIT";    // 房主关闭服务器

// 服务器 -> 客户端
inline const std::string WELCOME  = "WELCOME";
inline const std::string ASK_NAME = "ASK_NAME";
inline const std::string ASK_LEVEL = "ASK_LEVEL";
inline const std::string ASK_TYPES = "ASK_TYPES";
inline const std::string ASK_START = "ASK_START";
inline const std::string ASK_SETTINGS = "ASK_SETTINGS";
inline const std::string RECONNECTED = "RECONNECTED";
inline const std::string INFO     = "INFO";
inline const std::string ERROR_   = "ERROR";
inline const std::string ROUND    = "ROUND";
inline const std::string TIME     = "TIME";
inline const std::string QUESTION = "QUESTION";
inline const std::string RESULT   = "RESULT";
inline const std::string SCORES   = "SCORES";
inline const std::string FINAL    = "FINAL";
inline const std::string BYE      = "BYE";
inline const std::string ROLE     = "ROLE";     // ROLE host / ROLE guest
inline const std::string RESTART  = "RESTART";  // 一局结束，服务器回到大厅等待下一局
inline const std::string BUZZ_OK  = "BUZZ_OK";  // 抢答即时判分：答对，后跟本轮得分
inline const std::string BUZZ_NO  = "BUZZ_NO";  // 抢答即时判分：答错，本轮锁定

// ---------------- 局域网自动发现 ----------------
// 服务器每秒向 UDP 8848 广播 "VOCAB_SERVER <TCP端口>"，客户端监听 3 秒收集。
inline const std::string DISCOVERY_TAG = "VOCAB_SERVER";
constexpr int DISCOVERY_PORT = 8848;
constexpr int DISCOVERY_LISTEN_MS = 3000;

} // namespace proto
