#pragma once
// 跨平台 TCP 套接字封装（Windows 用 Winsock2，Unix 用 BSD socket）。
#include <string>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <sys/socket.h>
#include <sys/select.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#endif

namespace net {

#ifdef _WIN32
using Socket = SOCKET;
constexpr Socket INVALID_SOCK = INVALID_SOCKET;
#else
using Socket = int;
constexpr Socket INVALID_SOCK = -1;
#endif

// 初始化 / 清理（Windows 上需要 WSAStartup / WSACleanup）
bool init();
void cleanup();

// 把当前控制台的输入输出切换为 UTF-8，保证中文正确显示与比对
void setup_console_utf8();

// 服务器：创建并监听端口，返回监听套接字。
// bindIp 为要监听的本机 IPv4 地址：127.0.0.1 只允许本机连接，0.0.0.0 表示所有网卡
Socket listen_on(int port, const std::string& bindIp = "0.0.0.0", int backlog = 16);
// 服务器：接受一个客户端连接（阻塞）
Socket accept_client(Socket listen_sock);
// 客户端：连接到指定 IP / 端口（支持 "localhost" 与域名）
Socket connect_to(const std::string& ip, int port);

// 发送一行（自动补 '\n'），失败返回 false
bool send_line(Socket s, const std::string& line);
// 接收一行（去掉行尾 '\r' '\n'）；出错 / 对端关闭返回 false
bool recv_line(Socket s, std::string& line);
// 带超时地接收一行：返回 1=收到一行，0=超时，-1=出错/对端关闭
int recv_line_timeout(Socket s, std::string& line, int timeout_ms);

// ---- UDP（局域网服务器自动发现） ----
// 向 255.255.255.255:port 广播一条消息，失败返回 false
bool udp_broadcast(int port, const std::string& msg);
// 监听 UDP 端口（允许与同机其它监听者共用端口），失败返回 INVALID_SOCK
Socket udp_listen(int port);
// 带超时地收一个数据报；成功返回 true 并给出内容与来源 IPv4 字符串
bool udp_recv(Socket s, std::string& data, std::string& from_ip, int timeout_ms);

// 关闭套接字（先 shutdown 再 close，可唤醒对端阻塞的 recv）
void close_socket(Socket s);

} // namespace net
