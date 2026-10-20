#include "client.h"

#include "protocol.h"

#include <iostream>
#include <thread>
#include <chrono>
#include <cstdlib>
#include <vector>
#include <utility>

namespace {
long long nowMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}
} // namespace

Client::Client(const std::string& ip, int port) : ip_(ip), port_(port) {}

int Client::run() {
    // 后台输入线程（detach：进程退出时自动终止）；发现服务器阶段也需要读输入
    std::thread input(&Client::inputLoop, this);
    input.detach();

    if (ip_ == "auto") {
        if (!discoverServer()) { running_ = false; return 1; }
    }

    sock_ = net::connect_to(ip_, port_);
    if (sock_ == net::INVALID_SOCK) {
        std::cout << "[错误] 无法连接服务器 " << ip_ << ":" << port_ << "\n";
        return 1;
    }
    std::cout << "已连接到服务器 " << ip_ << ":" << port_ << "\n";

    std::string line;
    while (running_) {
        if (answering_ || waitingGuest_) {
            std::string in = tryPop();
            if (!in.empty()) {
                if (answering_) {
                    send(proto::ANSWER + " " + std::to_string(round_) + " " + in);
                    answering_ = false;
                } else {
                    send(proto::NUDGE);
                    std::cout << "已催促房主开始。\n";
                }
                continue;
            }
            if (answering_ && nowMs() >= deadlineMs_) {
                std::cout << "（时间到）\n";
                send(proto::TIMEOUT + " " + std::to_string(round_));
                answering_ = false;
                continue;
            }
            std::string msg;
            int rc = net::recv_line_timeout(sock_, msg, 100);
            if (rc == 1) {
                handleMessage(msg);
            } else if (rc == -1) {
                std::cout << "\n[已与服务器断开连接]\n";
                break;
            }
            continue;
        }

        if (!net::recv_line(sock_, line)) {
            std::cout << "\n[已与服务器断开连接]\n";
            break;
        }
        handleMessage(line);
    }

    running_ = false;
    qcv_.notify_all();
    net::close_socket(sock_);
    return 0;
}

// ---------------- 局域网自动发现 ----------------

bool Client::discoverServer() {
    std::vector<std::pair<std::string, int>> found;
    std::cout << "正在搜索局域网内的服务器...\n";
    net::Socket u = net::udp_listen(proto::DISCOVERY_PORT);
    if (u != net::INVALID_SOCK) {
        long long end = nowMs() + proto::DISCOVERY_LISTEN_MS;
        while (nowMs() < end) {
            std::string data, from;
            if (!net::udp_recv(u, data, from, 500)) continue;
            auto cmd = proto::splitCmd(data);
            if (cmd.first != proto::DISCOVERY_TAG) continue;
            int port = std::atoi(cmd.second.c_str());
            if (port <= 0) port = 8848;
            bool dup = false;
            for (auto& f : found) if (f.first == from && f.second == port) dup = true;
            if (!dup) found.emplace_back(from, port);
        }
        net::close_socket(u);
    }

    auto askManual = [&](const char* prompt) {
        std::cout << prompt << std::flush;
        std::string s = proto::trim(popLineBlocking());
        if (!running_) return false;
        ip_ = s.empty() ? "localhost" : s;
        port_ = 8848;
        return true;
    };

    if (found.empty())
        return askManual("未发现服务器，请输入服务器 IP 地址: ");

    std::cout << "找到 " << found.size() << " 个。\n请选择要连接的服务器：\n";
    for (size_t i = 0; i < found.size(); ++i)
        std::cout << "  " << (i + 1) << ") " << found[i].first << ":" << found[i].second << "\n";
    std::cout << "输入编号选择（输入 0 手动输入 IP）: " << std::flush;
    int idx = std::atoi(proto::trim(popLineBlocking()).c_str());
    if (idx >= 1 && idx <= (int)found.size()) {
        ip_ = found[idx - 1].first;
        port_ = found[idx - 1].second;
        return true;
    }
    return askManual("请输入服务器 IP 地址: ");
}

// ---------------- 输入线程 ----------------

void Client::inputLoop() {
    std::string line;
    while (running_) {
        if (!std::getline(std::cin, line)) break;
        pushLine(line);
    }
}

void Client::pushLine(const std::string& s) {
    std::lock_guard<std::mutex> lk(qmtx_);
    q_.push(s);
    qcv_.notify_all();
}

std::string Client::popLineBlocking() {
    std::unique_lock<std::mutex> lk(qmtx_);
    qcv_.wait(lk, [&] { return !q_.empty() || !running_; });
    if (q_.empty()) return "";
    std::string s = q_.front();
    q_.pop();
    return s;
}

std::string Client::tryPop() {
    std::lock_guard<std::mutex> lk(qmtx_);
    if (q_.empty()) return "";
    std::string s = q_.front();
    q_.pop();
    return s;
}

void Client::clearQueue() {
    std::lock_guard<std::mutex> lk(qmtx_);
    std::queue<std::string> empty;
    std::swap(q_, empty);
}

void Client::send(const std::string& s) {
    net::send_line(sock_, s);
}

// ---------------- 消息处理 ----------------

void Client::handleMessage(const std::string& line) {
    auto cmd = proto::splitCmd(line);
    const std::string& c = cmd.first;
    const std::string& rest = cmd.second;

    if (c == proto::WELCOME) {
        std::cout << rest << "\n";
    } else if (c == proto::ASK_NAME) {
        std::cout << "请输入你的昵称: " << std::flush;
        std::string n = proto::trim(popLineBlocking());
        send(proto::JOIN + " " + n);
    } else if (c == proto::ASK_LEVEL) {
        showLevelMenu();
        std::string l = proto::toLower(proto::trim(popLineBlocking()));
        int idx = std::atoi(l.c_str());
        if (idx >= 1 && idx <= (int)proto::LEVELS().size())
            l = proto::LEVELS()[idx - 1];
        send(proto::LEVEL + " " + l);
    } else if (c == proto::ASK_TYPES) {
        showTypeMenu();
        std::string t = proto::trim(popLineBlocking());
        send(proto::TYPES + " " + t);
    } else if (c == proto::ROLE) {
        isHost_ = (rest == "host");
        if (isHost_) {
            waitingGuest_ = false;
            std::cout << "\n【你是房主】就绪后输入 start 竞速 / buzz 抢答 开始比赛\n";
        } else {
            waitingGuest_ = true;
            std::cout << "\n【你是客人】等待房主开始（可输入任意内容催促房主）\n";
        }
    } else if (c == proto::WAIT) {
        std::cout << rest << "\n";
    } else if (c == proto::ASK_START) {
        std::cout << "[房主] 输入 start 竞速 / buzz 抢答 / exit 退出 / 直接回车继续等待: " << std::flush;
        std::string s = proto::toLower(proto::trim(popLineBlocking()));
        if (s == "start") send(proto::START + " race");
        else if (s == "buzz") send(proto::START + " buzz");
        else if (s == "exit" || s == "quit") send(proto::EXIT);
        else send(proto::WAIT);
    } else if (c == proto::ASK_SETTINGS) {
        auto dv = proto::split(rest, ' ');
        std::string defRounds = (dv.size() > 0 && !dv[0].empty()) ? dv[0] : "10";
        std::string defSecs = (dv.size() > 1 && !dv[1].empty()) ? dv[1] : "20";
        std::cout << "[房主] 设置游戏参数。格式: <轮数> <每题秒数> <连击1/0> <停顿秒数>，如 '15 30 0 1'；"
                  << "直接回车用默认(" << defRounds << " 轮, " << defSecs
                  << " 秒, 连击禁用, 停顿 1 秒): " << std::flush;
        std::string s = proto::trim(popLineBlocking());
        if (s.empty()) s = defRounds + " " + defSecs + " 0 1";
        send(proto::SETTINGS + " " + s);
    } else if (c == proto::RECONNECTED) {
        std::cout << "[重连成功] 已恢复你之前的游戏进度（昵称：" << rest << "）\n";
    } else if (c == proto::INFO) {
        std::cout << "[提示] " << rest << "\n";
    } else if (c == proto::ERROR_) {
        std::cout << "[错误] " << rest << "\n";
    } else if (c == proto::RESTART) {
        answering_ = false;
        std::cout << "\n" << rest << "\n";
        clearQueue();
        // 客人回到等待状态；房主随后会收到 ASK_START
        waitingGuest_ = !isHost_;
    } else if (c == proto::ROUND) {
        waitingGuest_ = false;
        auto f = proto::split(rest, ' ');
        round_ = std::atoi(f.empty() ? "0" : f[0].c_str());
        std::string total = f.size() > 1 ? f[1] : "?";
        std::cout << "\n======== 第 " << round_ << " / " << total << " 轮 ========\n";
    } else if (c == proto::TIME) {
        roundTimeSec_ = std::atoi(rest.c_str());
    } else if (c == proto::QUESTION) {
        clearQueue();
        auto f = proto::splitFirst(rest, '|');
        printQuestion(f.first, f.second);
        answering_ = true;
        deadlineMs_ = nowMs() + (long long)roundTimeSec_ * 1000;
    } else if (c == proto::RESULT) {
        answering_ = false;
        printResult(rest);
    } else if (c == proto::SCORES) {
        printScoreboard(rest);
    } else if (c == proto::FINAL) {
        printFinal(rest);
    } else if (c == proto::BYE) {
        std::cout << rest << "\n";
        running_ = false;
    } else {
        std::cout << "[未知消息] " << line << "\n";
    }
}

// ---------------- 显示 ----------------

void Client::showLevelMenu() {
    std::cout << "\n可选的难度等级（越难每题得分越高）:\n";
    int i = 1;
    for (const auto& l : proto::LEVELS())
        std::cout << "  " << i++ << ") " << l << "  " << proto::levelName(l)
                  << "（基础 " << proto::baseScore(l) << " 分/题）\n";
    std::cout << "输入等级编号或代号（如 1 或 cet4）: " << std::flush;
}

void Client::showTypeMenu() {
    std::cout << "\n可选题型（可多选，用逗号分隔，如 mcq,en2zh）:\n";
    for (const auto& t : proto::QTYPES())
        std::cout << "  " << t << "  " << proto::typeName(t) << "\n";
    std::cout << "输入题型（逗号分隔）: " << std::flush;
}

void Client::printQuestion(const std::string& type, const std::string& payload) {
    auto f = proto::split(payload, '|');
    if (type == "mcq" && f.size() >= 5) {
        std::cout << "【英译中选择】选出下面单词的中文释义：\n";
        std::cout << "  单词: " << f[0] << "\n";
        std::cout << "  A. " << f[1] << "\n  B. " << f[2] << "\n  C. " << f[3] << "\n  D. " << f[4] << "\n";
        std::cout << "输入选项 (A/B/C/D 或 1/2/3/4): " << std::flush;
    } else if (type == "zh2en_mcq" && f.size() >= 5) {
        std::cout << "【中译英】选出下面释义对应的英文单词：\n";
        std::cout << "  释义: " << f[0] << "\n";
        std::cout << "  A. " << f[1] << "\n  B. " << f[2] << "\n  C. " << f[3] << "\n  D. " << f[4] << "\n";
        std::cout << "输入选项 (A/B/C/D 或 1/2/3/4): " << std::flush;
    } else if (type == "en2zh" && !f.empty()) {
        std::cout << "【英译中】写出下面单词的中文释义：\n";
        std::cout << "  " << f[0] << "\n";
        std::cout << "输入中文释义: " << std::flush;
    } else if (type == "zh2en" && !f.empty()) {
        std::cout << "【中译英】写出下面释义对应的英文单词：\n";
        std::cout << "  " << f[0] << "\n";
        std::cout << "输入英文单词: " << std::flush;
    } else if (type == "spell" && f.size() >= 2) {
        std::cout << "【拼写】根据释义和首字母拼出完整单词：\n";
        std::cout << "  释义: " << f[0] << "\n";
        std::cout << "  首字母: " << f[1] << "\n";
        std::cout << "输入完整单词: " << std::flush;
    }
}

void Client::printResult(const std::string& data) {
    auto f = proto::split(data, '|');
    std::string status = f.size() > 0 ? f[0] : "";
    std::string pts = f.size() > 1 ? f[1] : "0";
    std::string combo = f.size() > 2 ? f[2] : "0";
    std::string english = f.size() > 3 ? f[3] : "";
    std::string phonetic = f.size() > 4 ? f[4] : "";
    std::string chinese = f.size() > 5 ? f[5] : "";

    if (status == "correct")
        std::cout << "  回答正确！ +" << pts << " 分（当前连击 " << combo << "）\n";
    else if (status == "wrong")
        std::cout << "  回答错误。\n";
    else if (status == "timeout")
        std::cout << "  超时。\n";
    else if (status == "missed")
        std::cout << "  本轮被别人抢先答对了。\n";
    else
        std::cout << "  本轮未得分。\n";

    if (!english.empty() || !chinese.empty()) {
        std::cout << "  正确答案：" << english;
        if (!phonetic.empty()) std::cout << " " << phonetic;
        std::cout << "（" << chinese << "）\n";
    }
}

void Client::printScoreboard(const std::string& data) {
    std::cout << "\n----- 当前排行榜 -----\n";
    for (const auto& e : proto::split(data, ',')) {
        auto kv = proto::split(e, '=');
        if (kv.size() == 2) std::cout << "  " << kv[0] << " : " << kv[1] << " 分\n";
    }
    std::cout << "----------------------\n";
}

void Client::printFinal(const std::string& data) {
    auto f = proto::splitFirst(data, '|');
    int rank = std::atoi(f.first.c_str());
    std::cout << "\n\n========== 比赛结束 ==========\n";
    printScoreboard(f.second);
    std::cout << "你的最终排名：第 " << rank << " 名\n";
    if (rank == 1) std::cout << "恭喜夺冠！\n";
    std::cout << "==============================\n";
}
