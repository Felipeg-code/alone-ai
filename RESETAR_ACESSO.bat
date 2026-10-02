@echo off
cd /d "%~dp0"
title Alone.AI - Resetar acesso
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0RESETAR_ACESSO.ps1"
if errorlevel 1 pause
