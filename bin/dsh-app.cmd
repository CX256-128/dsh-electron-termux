@echo off
rem Development launcher for Windows: Electron lives in dev\node_modules.
setlocal
cd /d "%~dp0.."
node tools\run.mjs %*
