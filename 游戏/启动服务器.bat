@echo off
cd /d "%~dp0"
echo ==========================================
echo   英语词汇擂台 - 服务器（擂主运行）
echo   启动后把下面显示的 IP 地址告诉所有同学
echo   如弹出防火墙提示，请点「允许访问」
echo ==========================================
vocab_battle.exe server
echo.
echo 比赛已结束。按任意键关闭窗口...
pause >nul
