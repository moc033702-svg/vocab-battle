#pragma once
// 服务器：接受连接线程 + UDP 广播线程 + 主线程赛程循环；
// 支持断线重连（按昵称）、房主/客人身份、催促、再来一局与房主关服。
#include <string>
#include <thread>
#include <atomic>
#include <map>
#include <mutex>

#include "net.h"
#include "game.h"

class Server {
public:
    // bindIp：监听的本机地址，网关部署时为 127.0.0.1，外部无法直接连接游戏端口
    Server(int port, int rounds, int roundTimeSec, const WordBank& bank, const std::string& bindIp = "0.0.0.0");
    int run();

private:
    int port_;
    std::string bind_ip_;
    Game game_;

    net::Socket listen_sock_ = net::INVALID_SOCK;
    std::map<int, net::Socket> sockets_;   // 玩家 id -> 套接字（sockets_mtx_ 保护）
    std::mutex sockets_mtx_;
    std::atomic<bool> start_requested_{false};
    std::atomic<bool> buzz_requested_{false};
    std::atomic<bool> exit_requested_{false};
    std::atomic<bool> in_game_{false};
    std::atomic<bool> running_{true};
    std::atomic<bool> awaiting_settings_{false}; // 房主是否正在填写开局设置

    void acceptLoop();
    void broadcastLoop();                  // 每秒向局域网广播 "VOCAB_SERVER <端口>"
    void handleClient(int id, net::Socket sock);
    void gameLoop(int id, net::Socket sock);
    void onPlayerLeft(int id);             // 玩家离开：标记离线，房主不在线时改选房主
    void runRaceGame();
    void runBuzzGame();
    void finishGame();
    void pauseAfterRound();
    void broadcastAll(const std::string& msg);
    bool isHost(int id) const { return id == game_.hostId(); }
    bool sendTo(int id, const std::string& msg);
    void closeAll();
    void printLocalIPs();
};
