#include "net.h"

#include <cstring>
#include <cstdint>

#ifdef _WIN32
#include <windows.h> // SetConsoleCP / SetConsoleOutputCP，需在 winsock2.h 之后包含
#endif

namespace net {

static bool g_inited = false;

bool init() {
#ifdef _WIN32
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return false;
#endif
    g_inited = true;
    return true;
}

void cleanup() {
#ifdef _WIN32
    if (g_inited) WSACleanup();
#endif
    g_inited = false;
}

void setup_console_utf8() {
#ifdef _WIN32
    SetConsoleCP(CP_UTF8);
    SetConsoleOutputCP(CP_UTF8);
#endif
}

Socket listen_on(int port, const std::string& bindIp, int backlog) {
    Socket s = socket(AF_INET, SOCK_STREAM, 0);
    if (s == INVALID_SOCK) return INVALID_SOCK;

    int yes = 1;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, (const char*)&yes, sizeof(yes));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    if (inet_pton(AF_INET, bindIp.c_str(), &addr.sin_addr) != 1) { close_socket(s); return INVALID_SOCK; }
    addr.sin_port = htons((uint16_t)port);

    if (bind(s, (sockaddr*)&addr, sizeof(addr)) != 0) { close_socket(s); return INVALID_SOCK; }
    if (listen(s, backlog) != 0) { close_socket(s); return INVALID_SOCK; }
    return s;
}

Socket accept_client(Socket listen_sock) {
    sockaddr_in from{};
#ifdef _WIN32
    int len = sizeof(from);
#else
    socklen_t len = sizeof(from);
#endif
    return accept(listen_sock, (sockaddr*)&from, &len);
}

Socket connect_to(const std::string& ip, int port) {
    addrinfo hints{}, *res = nullptr;
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    std::string portstr = std::to_string(port);
    if (getaddrinfo(ip.c_str(), portstr.c_str(), &hints, &res) != 0) return INVALID_SOCK;

    Socket s = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (s == INVALID_SOCK) { freeaddrinfo(res); return INVALID_SOCK; }

#ifdef _WIN32
    int rc = connect(s, res->ai_addr, (int)res->ai_addrlen);
#else
    int rc = connect(s, res->ai_addr, res->ai_addrlen);
#endif
    freeaddrinfo(res);
    if (rc != 0) { close_socket(s); return INVALID_SOCK; }
    return s;
}

bool send_line(Socket s, const std::string& line) {
    if (s == INVALID_SOCK) return false;
    std::string data = line + "\n";
    size_t sent = 0;
    while (sent < data.size()) {
#ifdef _WIN32
        int n = send(s, data.data() + sent, (int)(data.size() - sent), 0);
#else
        ssize_t n = send(s, data.data() + sent, data.size() - sent, MSG_NOSIGNAL);
#endif
        if (n <= 0) return false;
        sent += (size_t)n;
    }
    return true;
}

// 设置接收超时（ms < 0 表示无限阻塞）
static void set_recv_timeout(Socket s, int ms) {
#ifdef _WIN32
    DWORD tv = ms < 0 ? 0 : (DWORD)ms;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv, sizeof(tv));
#else
    timeval tv{};
    tv.tv_sec = ms / 1000;
    tv.tv_usec = (ms % 1000) * 1000;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv, sizeof(tv));
#endif
}

bool recv_line(Socket s, std::string& line) {
    line.clear();
    if (s == INVALID_SOCK) return false;
    set_recv_timeout(s, -1); // 恢复阻塞模式
    char c;
    for (;;) {
#ifdef _WIN32
        int n = recv(s, &c, 1, 0);
#else
        ssize_t n = recv(s, &c, 1, 0);
#endif
        if (n <= 0) return false; // 出错或对端关闭
        if (c == '\n') {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            return true;
        }
        line.push_back(c);
    }
}

int recv_line_timeout(Socket s, std::string& line, int timeout_ms) {
    line.clear();
    if (s == INVALID_SOCK) return -1;
    set_recv_timeout(s, timeout_ms);
    char c;
    for (;;) {
#ifdef _WIN32
        int n = recv(s, &c, 1, 0);
        if (n == SOCKET_ERROR) {
            int err = WSAGetLastError();
            if (err == WSAETIMEDOUT) { set_recv_timeout(s, -1); return 0; }
            set_recv_timeout(s, -1); return -1;
        }
#else
        ssize_t n = recv(s, &c, 1, 0);
        if (n < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) { set_recv_timeout(s, -1); return 0; }
            set_recv_timeout(s, -1); return -1;
        }
#endif
        if (n == 0) { set_recv_timeout(s, -1); return -1; } // 对端关闭
        if (c == '\n') {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            set_recv_timeout(s, -1);
            return 1;
        }
        line.push_back(c);
    }
}

void close_socket(Socket s) {
    if (s == INVALID_SOCK) return;
#ifdef _WIN32
    shutdown(s, SD_BOTH);
    closesocket(s);
#else
    shutdown(s, SHUT_RDWR);
    close(s);
#endif
}

} // namespace net

// ---------------- UDP ----------------

namespace net {

bool udp_broadcast(int port, const std::string& msg) {
    Socket s = socket(AF_INET, SOCK_DGRAM, 0);
    if (s == INVALID_SOCK) return false;
    int yes = 1;
    setsockopt(s, SOL_SOCKET, SO_BROADCAST, (const char*)&yes, sizeof(yes));
    sockaddr_in to{};
    to.sin_family = AF_INET;
    to.sin_port = htons((uint16_t)port);
    to.sin_addr.s_addr = htonl(INADDR_BROADCAST);
    int n = (int)sendto(s, msg.data(), (int)msg.size(), 0, (sockaddr*)&to, sizeof(to));
#ifdef _WIN32
    closesocket(s);
#else
    close(s);
#endif
    return n == (int)msg.size();
}

Socket udp_listen(int port) {
    Socket s = socket(AF_INET, SOCK_DGRAM, 0);
    if (s == INVALID_SOCK) return INVALID_SOCK;
    int yes = 1;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, (const char*)&yes, sizeof(yes));
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons((uint16_t)port);
    if (bind(s, (sockaddr*)&addr, sizeof(addr)) != 0) {
#ifdef _WIN32
        closesocket(s);
#else
        close(s);
#endif
        return INVALID_SOCK;
    }
    return s;
}

bool udp_recv(Socket s, std::string& data, std::string& from_ip, int timeout_ms) {
    data.clear();
    from_ip.clear();
    fd_set rfds;
    FD_ZERO(&rfds);
    FD_SET(s, &rfds);
    timeval tv{timeout_ms / 1000, (timeout_ms % 1000) * 1000};
#ifdef _WIN32
    int nfds = 0;
#else
    int nfds = (int)s + 1;
#endif
    if (select(nfds, &rfds, nullptr, nullptr, &tv) <= 0) return false;
    char buf[512];
    sockaddr_in from{};
#ifdef _WIN32
    int len = sizeof(from);
#else
    socklen_t len = sizeof(from);
#endif
    int n = (int)recvfrom(s, buf, sizeof(buf), 0, (sockaddr*)&from, &len);
    if (n <= 0) return false;
    data.assign(buf, buf + n);
    char ip[INET_ADDRSTRLEN] = {0};
    inet_ntop(AF_INET, &from.sin_addr, ip, sizeof(ip));
    from_ip = ip;
    return true;
}

} // namespace net
