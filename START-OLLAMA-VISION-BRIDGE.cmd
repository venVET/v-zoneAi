@echo off
title V TRADE AI - Ollama Vision Bridge
echo.
echo [V-TRADE] Checking Ollama...
curl -s http://127.0.0.1:11434/api/tags
if errorlevel 1 (
  echo.
  echo Ollama is not running. Starting Ollama...
  start "" ollama serve
  timeout /t 3 /nobreak >nul
)
echo.
echo [V-TRADE] Checking Vision model...
ollama show qwen2.5vl:3b >nul 2>&1
if errorlevel 1 (
  echo Model qwen2.5vl:3b not found. Pulling it now...
  ollama pull qwen2.5vl:3b
)
echo.
echo [V-TRADE] Starting local browser bridge on http://127.0.0.1:11435
echo Keep this window open while using Screenshot AI.
echo.
node "%~dp0local-ollama-bridge.mjs"
pause
