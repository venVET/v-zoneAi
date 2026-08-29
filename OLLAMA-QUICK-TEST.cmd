@echo off
title V TRADE AI - Ollama Vision Test
echo.
echo [1/3] Checking Ollama...
curl -s http://127.0.0.1:11434/api/tags
echo.
echo.
echo [2/3] Checking qwen2.5vl:3b...
ollama show qwen2.5vl:3b
if errorlevel 1 (
  echo.
  echo Model not found. Run:
  echo   ollama pull qwen2.5vl:3b
  echo.
  pause
  exit /b 1
)
echo.
echo [3/3] Ollama Vision is ready.
echo Keep Ollama running, then use Screenshot AI in V TRADE AI.
echo.
pause
