@echo off
setlocal
cd /d "%~dp0"
title Preparar Chatbot Alone v6.2
cls
echo ======================================================
echo       PREPARAR CHATBOT ALONE - MODO DESENVOLVIMENTO
echo ======================================================
echo.
where node >nul 2>&1
if errorlevel 1 (
  echo [ERRO] Node.js nao foi encontrado neste computador.
  echo Para o uso normal, voce NAO precisa deste modo.
  echo Prefira o pacote Windows portatil com Chatbot-Alone.exe.
  echo.
  pause
  exit /b 1
)
where npm >nul 2>&1
if errorlevel 1 (
  echo [ERRO] npm nao foi encontrado.
  pause
  exit /b 1
)

echo Instalando dependencias do projeto...
cd /d "%~dp0codigo-fonte-dev"
call npm install
if errorlevel 1 (
  echo.
  echo [ERRO] Nao foi possivel instalar as dependencias.
  echo Verifique a internet e tente novamente.
  pause
  exit /b 1
)

echo.
echo Preparacao concluida.
echo Agora use INICIAR_CHATBOT.bat
pause
