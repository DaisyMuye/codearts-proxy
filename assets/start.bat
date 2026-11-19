@echo off
chcp 65001 >nul
cd /d %~dp0
echo ============================================
echo  码道(DeepSeek) -> OpenAI 兼容反代
echo  Base URL : http://127.0.0.1:8787/v1
echo  API Key  : 随便填 (sk-local)
echo  Model    : deepseek-v4.1-flash-1017
echo ============================================
echo.
echo [前提] Chrome 已开启远程调试，且已登录码道聊天页
echo.
node dsproxy.mjs
pause
