#pragma once
// 客户端：连接服务器，交互式大厅 + 比赛答题。
// 两个线程：主线程收服务器消息；后台线程读用户输入（支持限时作答）。
// 新增：局域网自动发现（ip 为 "auto"）、房主/客人身份、客人催促。
#include <string>
#include <queue>
#include <mutex>
#include <condition_variable>
#include <atomic>

#include "net.h"

class Client {
public:
    Client(const std::string& ip, int port);
    int run();

private:
    std::string ip_;
    int port_;
    net::Socket sock_ = net::INVALID_SOCK;

    std::mutex qmtx_;
    std::condition_variable qcv_;
    std::queue<std::string> q_;
    std::atomic<bool> running_{true};

    int round_ = 0;
    int roundTimeSec_ = 20;
    bool answering_ = false;
    bool waitingGuest_ = false;       // 客人在大厅等待开赛（输入任意内容催促房主）
    bool isHost_ = false;
    long long deadlineMs_ = 0;

    bool discoverServer();            // 搜索局域网并让用户选择，填充 ip_/port_
    void inputLoop();
    void pushLine(const std::string& s);
    std::string popLineBlocking();
    std::string tryPop();
    void clearQueue();

    void send(const std::string& s);
    void handleMessage(const std::string& line);

    void printQuestion(const std::string& type, const std::string& payload);
    void printResult(const std::string& data);
    void printScoreboard(const std::string& data);
    void printFinal(const std::string& data);
    void showLevelMenu();
    void showTypeMenu();
};
