// 英语词汇比拼擂台 - 程序入口
// 用法：
//   vocab_battle server [端口=8848] [轮数=10] [每轮秒数=20] [监听地址=0.0.0.0]
//   vocab_battle client <服务器IP|auto> [端口=8848]
#include <iostream>
#include <string>
#include <cstring>
#include <cstdlib>

#include "net.h"
#include "word_bank.h"
#include "server.h"
#include "client.h"

static void printUsage(const char* argv0) {
    std::cout << "用法:\n";
    std::cout << "  " << argv0 << " server [端口=8848] [轮数=10] [每轮秒数=20] [监听地址=0.0.0.0]\n";
    std::cout << "  " << argv0 << " client <服务器IP|auto> [端口=8848]\n";
    std::cout << "\n示例:\n";
    std::cout << "  " << argv0 << " server              # 在本机启动服务器\n";
    std::cout << "  " << argv0 << " client auto         # 自动搜索局域网内的服务器\n";
    std::cout << "  " << argv0 << " client 192.168.1.5  # 玩家连接到该 IP\n";
    std::cout << "  " << argv0 << " client localhost    # 本机自测\n";
}

int main(int argc, char** argv) {
    net::setup_console_utf8();

    if (!net::init()) {
        std::cerr << "[错误] 网络初始化失败\n";
        return 1;
    }

    int ret = 0;
    if (argc >= 2 && std::strcmp(argv[1], "server") == 0) {
        int port = argc >= 3 ? std::atoi(argv[2]) : 8848;
        int rounds = argc >= 4 ? std::atoi(argv[3]) : 10;
        int secs = argc >= 5 ? std::atoi(argv[4]) : 20;
        std::string bindIp = argc >= 6 ? argv[5] : "0.0.0.0";

        WordBank bank;
        if (!bank.loadFromFile("data/words.csv")) {
            bank.loadDefaults();
            std::cout << "[提示] 未找到 data/words.csv，使用内置兜底词库。\n";
        }
        std::cout << "[提示] 已加载词库 " << bank.size() << " 个单词。\n";

        Server server(port, rounds, secs, bank, bindIp);
        ret = server.run();
    } else if (argc >= 3 && std::strcmp(argv[1], "client") == 0) {
        int port = argc >= 4 ? std::atoi(argv[3]) : 8848;
        Client client(argv[2], port);
        ret = client.run();
    } else {
        printUsage(argv[0]);
    }

    net::cleanup();
    return ret;
}
