@echo off
setlocal
chcp 65001 >nul
title 梅花幼儿园复盘部
cd /d "%~dp0"

rem Electron 被当成纯 Node 跑时（某些终端会设 ELECTRON_RUN_AS_NODE=1），
rem require('electron') 只剩一个路径字符串，app 会是 undefined。先清掉。
set ELECTRON_RUN_AS_NODE=

set "EXE=%~dp0node_modules\electron\dist\electron.exe"
set "LOGF=%~dp0启动日志.txt"

if not exist "%EXE%" (
  echo [首次运行] 正在安装运行时，约 200MB，请稍候...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo 安装失败：请确认已经装了 Node.js，并且电脑能联网。
    pause
    exit /b 1
  )
)

if not exist "%EXE%" (
  echo 装完了还是找不到 electron.exe，请在本目录手动执行：npm install
  pause
  exit /b 1
)

rem 清掉上一次的日志，便于对照
if exist "%LOGF%" del "%LOGF%" >nul 2>nul

echo 正在启动...
start "" "%EXE%" "%~dp0."

rem 最多等 12 秒：进程还在就算启动成功（窗口会自己出来）
for /l %%i in (1,1,12) do (
  ping -n 2 127.0.0.1 >nul
  "%SystemRoot%\System32\tasklist.exe" /FI "IMAGENAME eq electron.exe" 2>nul | "%SystemRoot%\System32\find.exe" /I "electron.exe" >nul
  if not errorlevel 1 exit /b 0
)

echo.
echo ------------------------------------------------------------
echo  启动失败：12 秒内没看到任何 Electron 进程。
echo.
echo  下面是启动日志（也可以直接把同目录的 启动日志.txt 发给我）：
echo ------------------------------------------------------------
if exist "%LOGF%" (
  type "%LOGF%"
) else (
  echo （没有生成日志：说明程序在写出第一行日志之前就退出了）
)
echo ------------------------------------------------------------
pause
exit /b 1
