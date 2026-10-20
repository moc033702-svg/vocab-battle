cmake_minimum_required(VERSION 3.16)
project(vocab_battle LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 源代码统一按 UTF-8 处理（词库和界面包含中文）
if(MSVC)
    add_compile_options(/utf-8 /W3)
else()
    add_compile_options(-Wall -Wextra)
endif()

add_executable(vocab_battle
    src/main.cpp
    src/net.cpp
    src/word_bank.cpp
    src/game.cpp
    src/server.cpp
    src/client.cpp
)

target_include_directories(vocab_battle PRIVATE src)

# Windows 下链接 Winsock
if(WIN32)
    target_link_libraries(vocab_battle ws2_32)
endif()

# 线程库（Windows/MSVC 下为空，Linux 下链接 pthread）
find_package(Threads REQUIRED)
target_link_libraries(vocab_battle Threads::Threads)
