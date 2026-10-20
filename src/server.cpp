#include "server.h"

#include "protocol.h"

#include <iostream>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <vector>

Server::Server(int port, int rounds, int roundTimeSec, const WordBank& bank, const std::string& bindIp)
    : port_(port), bind_ip_(bindIp), game_(bank, rounds, roundTimeSec) {}

int Server::run() {
    listen_sock_ = net::listen_on(port_, bind_ip_);
    if (listen_sock_ == net::INVALID_SOCK) {
        std::cerr << "[错误] 无法监听端口 " << port_ << "，可能已被占用。\n";
        return 1;
    }

    std::cout << "==========================================\n";
    std::cout << "  英语词汇比拼擂台 - 服务器\n";
    std::cout << "==========================================\n";
    if (bind_ip_ == "0.0.0.0") printLocalIPs();
    std::cout << "监听地址: " << bind_ip_ << ":" << port_ << "\n";
    std::cout << "比赛配置: " << game_.totalRounds() << " 轮，每轮 " << game_.roundTimeSec() << " 秒\n";
    std::cout << "第一位加入的玩家是房主，输入 start / buzz 开始比赛，exit 关闭服务器。\n";
    std::cout << "等待玩家加入...\n";

    std::thread accept_thread(&Server::acceptLoop, this);
    std::thread bcast_thread(&Server::broadcastLoop, this);

    // 多局循环：每局结束后回到大厅，直到房主输入 exit
    while (running_ && !exit_requested_) {
        if (!start_requested_) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            continue;
        }
        if (!game_.canStart()) { start_requested_ = false; continue; }

        in_game_ = true;
        if (buzz_requested_) runBuzzGame();
        else runRaceGame();
        in_game_ = false;

        if (exit_requested_) break;
        // 再来一局：分数重置、玩家保留
        game_.resetForRematch();
        start_requested_ = false;
        buzz_requested_ = false;
        broadcastAll(proto::RESTART + " 再来一局！等待房主开赛...");
        sendTo(game_.hostId(), proto::ASK_START);
    }

    if (exit_requested_) {
        broadcastAll(proto::BYE + " 服务器已关闭，再见！");
        std::this_thread::sleep_for(std::chrono::milliseconds(300));
    }
    std::cout << "服务器退出。\n";

    running_ = false;
    net::close_socket(listen_sock_);
    closeAll();
    if (accept_thread.joinable()) accept_thread.join();
    if (bcast_thread.joinable()) bcast_thread.join();
    return 0;
}

void Server::acceptLoop() {
    while (running_) {
        fd_set rfds;
        FD_ZERO(&rfds);
        FD_SET(listen_sock_, &rfds);
        timeval tv{0, 300000}; // 300ms

#ifdef _WIN32
        int nfds = 0;
#else
        int nfds = (int)listen_sock_ + 1;
#endif
        int sel = select(nfds, &rfds, nullptr, nullptr, &tv);
        if (sel > 0 && FD_ISSET(listen_sock_, &rfds)) {
            net::Socket c = net::accept_client(listen_sock_);
            if (c != net::INVALID_SOCK) {
                int id = game_.addPlayer();
                {
                    std::lock_guard<std::mutex> lk(sockets_mtx_);
                    sockets_[id] = c;
                }
                std::cout << "[+] 玩家 (id=" << id << ") 已连接\n";
                std::thread(&Server::handleClient, this, id, c).detach();
            }
        }
    }
}

// 局域网自动发现：每秒广播一次 "VOCAB_SERVER <TCP端口>"
void Server::broadcastLoop() {
    const std::string msg = proto::DISCOVERY_TAG + " " + std::to_string(port_);
    while (running_) {
        net::udp_broadcast(proto::DISCOVERY_PORT, msg);
        for (int i = 0; i < 10 && running_; ++i)
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
}

bool Server::sendTo(int id, const std::string& msg) {
    net::Socket s;
    {
        std::lock_guard<std::mutex> lk(sockets_mtx_);
        auto it = sockets_.find(id);
        if (it == sockets_.end()) return false;
        s = it->second;
    }
    return net::send_line(s, msg);
}

void Server::broadcastAll(const std::string& msg) {
    std::vector<int> ids;
    {
        std::lock_guard<std::mutex> lk(game_.mutex());
        for (const auto& up : game_.players())
            if (up->connected) ids.push_back(up->id);
    }
    for (int id : ids) sendTo(id, msg);
}

void Server::closeAll() {
    std::lock_guard<std::mutex> lk(sockets_mtx_);
    for (auto& kv : sockets_) net::close_socket(kv.second);
}

static bool isLanIPv4(const std::string& ip) {
    auto parts = proto::split(ip, '.');
    if (parts.size() != 4) return false;
    int a = std::atoi(parts[0].c_str());
    int b = std::atoi(parts[1].c_str());
    if (a == 10) return true;
    if (a == 172 && b >= 16 && b <= 31) return true;
    if (a == 192 && b == 168) return true;
    return false;
}

void Server::printLocalIPs() {
    char host[256] = {0};
    if (gethostname(host, sizeof(host)) != 0) return;
    addrinfo hints{}, *res = nullptr;
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(host, nullptr, &hints, &res) != 0) return;

    std::vector<std::string> lan, other;
    for (auto* p = res; p; p = p->ai_next) {
        char ip[INET_ADDRSTRLEN] = {0};
        auto* sa = (sockaddr_in*)p->ai_addr;
        inet_ntop(AF_INET, &sa->sin_addr, ip, sizeof(ip));
        std::string sip(ip);
        if (sip.rfind("127.", 0) == 0) continue;
        if (isLanIPv4(sip)) lan.push_back(sip);
        else other.push_back(sip);
    }
    freeaddrinfo(res);

    if (!lan.empty()) {
        std::cout << "同学连接请用下面的 IP 地址（客户端也可自动发现）：\n";
        for (const auto& ip : lan) std::cout << "  " << ip << "\n";
    } else if (!other.empty()) {
        std::cout << "未检测到局域网 IP，若大家在同一网络可试：\n";
        for (const auto& ip : other) std::cout << "  " << ip << "\n";
    } else {
        std::cout << "未检测到可用 IP，请检查网络。\n";
    }
}

void Server::handleClient(int id, net::Socket sock) {
    std::string line;
    sendTo(id, "WELCOME 欢迎来到英语词汇比拼擂台！");

    // ---- 昵称 / 断线重连 ----
    std::string playerName;
    bool reconnected = false;
    sendTo(id, "ASK_NAME");
    while (running_) {
        if (!net::recv_line(sock, line)) { onPlayerLeft(id); net::close_socket(sock); return; }
        auto cmd = proto::splitCmd(line);
        if (cmd.first == proto::JOIN) {
            std::string name = proto::trim(cmd.second);
            if (name.empty()) {
                sendTo(id, "ERROR 昵称不能为空，请重新输入");
                sendTo(id, "ASK_NAME");
                continue;
            }
            int oldId = game_.findDisconnectedByName(name);
            if (oldId >= 0 && !game_.nameTaken(id, name)) {
                game_.adoptPlayer(id, oldId);
                if (oldId == game_.hostId()) game_.setHostId(id); // 房主重连，继续做房主
                game_.electHost();                                // 房主仍不在线时由重连者接任
                playerName = name;
                reconnected = true;
                break;
            }
            if (in_game_) {
                sendTo(id, "ERROR 比赛进行中，无法加入新玩家");
                onPlayerLeft(id);
                net::close_socket(sock);
                return;
            }
            if (game_.nameTaken(id, name)) {
                sendTo(id, "ERROR 该昵称已被使用，请换一个");
                sendTo(id, "ASK_NAME");
                continue;
            }
            game_.setName(id, name);
            playerName = name;
            break;
        }
        sendTo(id, "ERROR 请输入昵称");
        sendTo(id, "ASK_NAME");
    }

    if (reconnected) {
        std::cout << "[+] 玩家 " << playerName << " 重连\n";
        sendTo(id, proto::RECONNECTED + " " + playerName);
        sendTo(id, proto::ROLE + (isHost(id) ? " host" : " guest"));
        sendTo(id, "WAIT 已重连，恢复原分数，等待下一题...");
    } else {
        sendTo(id, "ASK_LEVEL");
        bool leveled = false;
        while (running_ && !leveled) {
            if (!net::recv_line(sock, line)) { onPlayerLeft(id); net::close_socket(sock); return; }
            auto cmd = proto::splitCmd(line);
            if (cmd.first == proto::LEVEL && game_.setLevel(id, proto::toLower(proto::trim(cmd.second))))
                leveled = true;
            else {
                sendTo(id, "ERROR 无效的难度等级");
                sendTo(id, "ASK_LEVEL");
            }
        }

        sendTo(id, "ASK_TYPES");
        bool typed = false;
        while (running_ && !typed) {
            if (!net::recv_line(sock, line)) { onPlayerLeft(id); net::close_socket(sock); return; }
            auto cmd = proto::splitCmd(line);
            if (cmd.first == proto::TYPES) {
                auto v = proto::split(proto::trim(cmd.second), ',');
                for (auto& t : v) t = proto::toLower(proto::trim(t));
                if (game_.setTypes(id, v)) typed = true;
                else { sendTo(id, "ERROR 无效的题型"); sendTo(id, "ASK_TYPES"); }
            }
        }

        game_.finishLobby(id);
        game_.electHost();   // 房主不在线时，刚就绪的这位接任（之后的 ROLE 行会告知他）
        std::cout << "[+] 玩家 " << playerName << " 已就绪\n";
        sendTo(id, proto::ROLE + (isHost(id) ? " host" : " guest"));
        sendTo(id, "WAIT 已就绪！等待其他玩家...");
        if (isHost(id)) sendTo(id, "ASK_START");
    }

    gameLoop(id, sock);
    net::close_socket(sock);
}

// 玩家离开（掉线、主动退出或注册失败）。若离开的是房主，改选房主并通知新房主
void Server::onPlayerLeft(int id) {
    game_.markDisconnected(id);
    if (game_.electHost() < 0) return;
    const int newHost = game_.hostId();
    sendTo(newHost, proto::ROLE + " host");
    if (!in_game_) sendTo(newHost, proto::ASK_START);
}

void Server::gameLoop(int id, net::Socket sock) {
    std::string line;
    while (running_) {
        if (!net::recv_line(sock, line)) { onPlayerLeft(id); break; }
        auto cmd = proto::splitCmd(line);

        if (cmd.first == proto::START && isHost(id) && !in_game_) {
            if (game_.canStart()) {
                buzz_requested_ = (proto::toLower(proto::trim(cmd.second)) == "buzz");
                awaiting_settings_ = true;
                sendTo(id, proto::ASK_SETTINGS + " " + std::to_string(game_.totalRounds())
                       + " " + std::to_string(game_.roundTimeSec()));
            } else {
                sendTo(id, "INFO 至少需要 2 名玩家且全部就绪后才能开始");
                sendTo(id, "ASK_START");
            }
        } else if (cmd.first == proto::SETTINGS && isHost(id) && awaiting_settings_ && !in_game_) {
            // <轮数> <每题秒数> <连击 1/0> <停顿秒数>
            auto toks = proto::split(proto::trim(cmd.second), ' ');
            int rounds = game_.totalRounds();
            int secs = game_.roundTimeSec();
            int pause = game_.pauseSec();
            bool combo = false;
            if (toks.size() >= 1 && !toks[0].empty()) {
                rounds = std::max(1, std::min(100, std::atoi(toks[0].c_str())));
            }
            if (toks.size() >= 2 && !toks[1].empty()) {
                secs = std::max(1, std::min(300, std::atoi(toks[1].c_str())));
            }
            if (toks.size() >= 3 && !toks[2].empty()) combo = (toks[2] == "1");
            if (toks.size() >= 4 && !toks[3].empty()) {
                pause = std::max(0, std::min(10, std::atoi(toks[3].c_str())));
            }
            game_.setTotalRounds(rounds);
            game_.setRoundTimeSec(secs);
            game_.setComboEnabled(combo);
            game_.setPauseSec(pause);
            awaiting_settings_ = false;
            start_requested_ = true;
        } else if (cmd.first == proto::EXIT && isHost(id) && !in_game_) {
            exit_requested_ = true;
        } else if (cmd.first == proto::WAIT && isHost(id) && !in_game_) {
            sendTo(id, "ASK_START");
        } else if (cmd.first == proto::NUDGE && !isHost(id) && !in_game_) {
            std::string nm;
            {
                std::lock_guard<std::mutex> lk(game_.mutex());
                if (const PlayerState* p = game_.find(id)) nm = p->name;
            }
            sendTo(game_.hostId(), "INFO 玩家 " + nm + " 催促你开始比赛");
        } else if (cmd.first == proto::ANSWER) {
            auto pr = proto::splitFirst(cmd.second, ' ');
            int round = std::atoi(pr.first.c_str());
            if (buzz_requested_) {
                // 抢答模式：立刻告诉本人对错，不用等整轮结束
                BuzzResult res = game_.recordBuzzAnswer(id, round, pr.second);
                if (res == BuzzResult::Correct) {
                    int pts = 0;
                    {
                        std::lock_guard<std::mutex> lk(game_.mutex());
                        if (const PlayerState* p = game_.find(id)) pts = p->roundPoints;
                    }
                    sendTo(id, proto::BUZZ_OK + " " + std::to_string(pts));
                } else if (res == BuzzResult::Wrong) {
                    sendTo(id, proto::BUZZ_NO);
                }
            } else {
                game_.recordAnswer(id, round, pr.second);
            }
        } else if (cmd.first == proto::TIMEOUT) {
            int round = std::atoi(cmd.second.c_str());
            if (buzz_requested_) game_.recordBuzzTimeout(id, round);
            else game_.recordTimeout(id, round);
        } else if (cmd.first == proto::QUIT) {
            onPlayerLeft(id);
            break;
        }
    }
}

void Server::pauseAfterRound() {
    int p = game_.pauseSec();
    if (p > 0) std::this_thread::sleep_for(std::chrono::seconds(p));
}

void Server::runRaceGame() {
    int total = game_.totalRounds();
    int secs = game_.roundTimeSec();
    std::cout << "\n===== 竞速模式开始！共 " << total << " 轮，每轮 " << secs << " 秒 =====\n";

    for (int r = 1; r <= total; ++r) {
        game_.startRound();

        {
            std::lock_guard<std::mutex> lk(game_.mutex());
            for (const auto& up : game_.players()) {
                const PlayerState& p = *up;
                if (!p.connected) continue;
                sendTo(p.id, proto::ROUND + " " + std::to_string(r) + " " + std::to_string(total));
                sendTo(p.id, proto::TIME + " " + std::to_string(secs));
                sendTo(p.id, proto::QUESTION + " " + p.qtype + "|" + p.qpayload);
            }
        }

        {
            std::unique_lock<std::mutex> lk(game_.mutex());
            game_.cv().wait_for(lk, std::chrono::seconds(secs), [&] { return game_.roundFinished(); });
        }
        game_.forceTimeoutRemaining();
        game_.scoreRound();

        {
            std::lock_guard<std::mutex> lk(game_.mutex());
            std::string sb = game_.scoreboardString();
            for (const auto& up : game_.players()) {
                const PlayerState& p = *up;
                if (!p.connected) continue;
                std::string status = (p.state == AnsState::Timeout) ? "timeout"
                                    : (p.roundCorrect ? "correct" : "wrong");
                sendTo(p.id, proto::RESULT + " " + status + "|" + std::to_string(p.roundPoints)
                            + "|" + std::to_string(p.combo) + "|" + p.wordEnglish + "|" + p.wordPhonetic + "|" + p.wordChinese);
                sendTo(p.id, proto::SCORES + " " + sb);
            }
        }
        if (r < total) pauseAfterRound();
    }
    pauseAfterRound();   // 最后一轮同样要停顿，让玩家看到本题对错再看结算

    finishGame();
}

void Server::finishGame() {
    {
        std::lock_guard<std::mutex> lk(game_.mutex());
        auto rank = game_.ranking();
        std::string sb = game_.scoreboardString();

        std::cout << "\n===== 比赛结束 =====\n";
        for (size_t i = 0; i < rank.size(); ++i) {
            const PlayerState* p = game_.find(rank[i]);
            std::cout << "第 " << (i + 1) << " 名：" << p->name
                      << "（" << p->score << " 分，答对 " << p->correct
                      << "，最高连击 " << p->bestCombo << "）\n";
        }

        for (const auto& up : game_.players()) {
            if (!up->connected) continue;
            int rk = 1;
            for (size_t i = 0; i < rank.size(); ++i)
                if (rank[i] == up->id) rk = (int)i + 1;
            sendTo(up->id, proto::FINAL + " " + std::to_string(rk) + "|" + sb);
        }
    }

    game_.saveMatch("data/history.csv", "data/leaderboard.csv");
    std::cout << "成绩已保存到 data/history.csv 与 data/leaderboard.csv\n";
}

void Server::runBuzzGame() {
    int total = game_.totalRounds();
    int secs = game_.roundTimeSec();
    std::cout << "\n===== 抢答模式开始！共 " << total << " 轮，每轮 " << secs << " 秒 =====\n";

    broadcastAll(proto::INFO + " 抢答模式：同一道题大家抢答，先答对者得分，答错本轮锁定");

    for (int r = 1; r <= total; ++r) {
        game_.startBuzzRound();

        {
            std::lock_guard<std::mutex> lk(game_.mutex());
            for (const auto& up : game_.players()) {
                const PlayerState& p = *up;
                if (!p.connected) continue;
                sendTo(p.id, proto::ROUND + " " + std::to_string(r) + " " + std::to_string(total));
                sendTo(p.id, proto::TIME + " " + std::to_string(secs));
                sendTo(p.id, proto::QUESTION + " " + game_.buzzType() + "|" + game_.buzzPayload());
            }
        }

        {
            std::unique_lock<std::mutex> lk(game_.mutex());
            game_.cv().wait_for(lk, std::chrono::seconds(secs), [&] { return game_.buzzRoundFinished(); });
        }
        game_.forceBuzzTimeout();

        {
            std::lock_guard<std::mutex> lk(game_.mutex());
            std::string sb = game_.scoreboardString();
            for (const auto& up : game_.players()) {
                const PlayerState& p = *up;
                if (!p.connected) continue;
                std::string status;
                if (p.state == AnsState::Answered)      status = "correct";
                else if (p.state == AnsState::Wrong)    status = "wrong";
                else if (p.state == AnsState::Timeout)  status = "timeout";
                else                                    status = "missed";
                sendTo(p.id, proto::RESULT + " " + status + "|" + std::to_string(p.roundPoints)
                            + "|" + std::to_string(p.combo) + "|" + game_.buzzEnglish() + "|" + game_.buzzPhonetic() + "|" + game_.buzzChinese());
                sendTo(p.id, proto::SCORES + " " + sb);
            }
        }
        if (r < total) pauseAfterRound();
    }
    pauseAfterRound();   // 最后一轮同样要停顿，让玩家看到本题对错再看结算

    finishGame();
}
