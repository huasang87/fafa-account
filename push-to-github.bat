@echo off
cd /d "%~dp0"
echo ========================================
echo 正在推送 Fafa的账本 到 GitHub
echo ========================================
echo.
echo 第一次推送需要登录 GitHub
echo 请按照提示操作...
echo.
"C:\Program Files\Git\bin\git.exe" push -u origin main
echo.
echo ========================================
echo 推送完成！
echo 现在去 GitHub 开启 Pages...
echo ========================================
pause
