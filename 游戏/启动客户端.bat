@echo off
cd /d "%~dp0"
echo ==========================================
echo   英语词汇擂台 - 客户端（玩家运行）
echo   正在自动搜索局域网内的服务器...
echo ==========================================
vocab_battle.exe client auto
echo.
echo 已退出。按任意键关闭窗口...
pause >nul
