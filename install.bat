@echo off
setlocal
rem Premiere Connector installer for Windows.
rem Builds the MCP server, signs the CEP panel with a self-signed certificate
rem (so Premiere loads it without PlayerDebugMode) and registers the server
rem with Claude Code and Claude Desktop.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1"
if errorlevel 1 (
  echo.
  echo Installation failed.
)
pause
