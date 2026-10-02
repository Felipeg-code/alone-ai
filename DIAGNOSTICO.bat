@echo off
setlocal
cd /d "%~dp0"
set OUT=diagnostico-alone.txt
(
 echo Alone.AI - Diagnostico
 echo Data: %date% %time%
 echo Pasta: %cd%
 if exist "Alone-Agent.exe" (echo MODO: EXE compilado) else if exist "INICIAR_ALONE.bat" (echo MODO: launcher com codigo-fonte - OK) else (echo INICIALIZADOR: AUSENTE)
 if exist "public\index.html" (echo PUBLIC: OK) else (echo PUBLIC: AUSENTE)
 if exist "data\settings.json" (echo SETTINGS: OK) else (echo SETTINGS: AUSENTE)
 if exist "data\flows.json" (echo FLOWS: OK) else (echo FLOWS: AUSENTE)
 if exist "codigo-fonte-dev\package-lock.json" (echo LOCKFILE: OK) else (echo LOCKFILE: AUSENTE)
 if exist "logs\server-error.log" (echo LOG ERRO: logs\server-error.log) else (echo LOG ERRO: ainda nao gerado)
 powershell -NoProfile -Command "try{$r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:3333/api/public-config; 'HTTP: '+$r.StatusCode}catch{'HTTP: OFFLINE - '+$_.Exception.Message}"
) > "%OUT%"
type "%OUT%"
echo.
echo Arquivo criado: %OUT%
pause
