@echo off
title Yanxiang EvolveShot
cd /d "%~dp0"

rem Launch the web server only; the frontend refreshes on its own once ready.
set PORT=9666
set DATA_DIR=%~dp0data
rem v1.0.17: closed loop - ComfyUI core + python_embeded + cuda-home all inside this folder
set COMFYUI_DIR=%~dp0ComfyUI
set COMFYUI_PYTHON=%~dp0python_embeded\python.exe
rem py312 still used by RealESRGAN hi-res fix + local TTS engine
set VIDEO_PYTHON=%~dp0py312\python.exe
set WORKFLOW_FILE=%~dp0work\complete-i2v.json

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found. Install Node.js 24+ first.
  pause
  exit /b 1
)

echo ============================================
echo   Yanxiang ^| EvolveShot
echo   Image-to-video + voice-clone dubbing system
echo   URL: http://127.0.0.1:%PORT%
echo   Login: videoadmin / admin123
echo ============================================
echo.

rem Open the browser ~2s later (after node binds the port), so it doesn't hit
rem a blank "connection refused" page. ping -n 3 is a dependency-free sleep.
start /b cmd /c "ping -n 3 127.0.0.1 >nul & start http://127.0.0.1:%PORT%"

node server\index.js
pause
