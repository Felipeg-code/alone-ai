@echo off
setlocal
cd /d "%~dp0codigo-fonte-dev"
where node >nul 2>&1 || (echo [ERRO] Node.js 22.13+ nao encontrado.& pause & exit /b 1)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" >nul 2>&1 || (echo [ERRO] Node.js 22.13+ e obrigatorio para o build com SQLite.& pause & exit /b 1)
echo Instalando dependencias reproduziveis pelo package-lock.json...
call npm ci --no-audit --no-fund || goto ERRO
echo Rodando testes...
cd /d "%~dp0"
node scripts\smoke-test-v744.js || goto ERRO
node scripts\smoke-test-v745.js || goto ERRO
node scripts\smoke-test-v748.js || goto ERRO
node scripts\smoke-test-v749.js || goto ERRO
node scripts\smoke-test-campaigns-v749.js || goto ERRO
node scripts\smoke-test-v7410.js || goto ERRO
node scripts\smoke-test-v7415.js || goto ERRO
node scripts\smoke-test-v7416.js || goto ERRO
node scripts\smoke-test-v7417.js || goto ERRO
node scripts\smoke-test-v7419.js || goto ERRO
node scripts\smoke-test-v7420.js || goto ERRO
node scripts\smoke-test-v7422.js || goto ERRO
node scripts\e2e-proactivity-v7423.js || goto ERRO
node scripts\smoke-test-v7424.js || goto ERRO
node scripts\smoke-test-v7425.js || goto ERRO
node scripts\smoke-test-v7427.js || goto ERRO
node scripts\smoke-test-campaign-specific-v7427.js || goto ERRO
node scripts\smoke-test-v7428.js || goto ERRO
node scripts\smoke-test-v7429.js || goto ERRO
node scripts\smoke-test-v7430.js || goto ERRO
cd /d "%~dp0codigo-fonte-dev"
echo Gerando Alone-Agent.exe...
call npm run build:exe || goto ERRO
echo.
echo Build criado em: codigo-fonte-dev\dist\Alone-Agent.exe
echo IMPORTANTE: o EXE precisa ficar ao lado das pastas public, data e audio.
pause
exit /b 0
:ERRO
echo.
echo [ERRO] O build falhou. Copie esta tela para o programador.
pause
exit /b 1
