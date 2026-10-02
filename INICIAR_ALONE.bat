@echo off
setlocal
cd /d "%~dp0"
title Alone.AI
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0INSTALAR_E_INICIAR.ps1"
if errorlevel 1 pause
