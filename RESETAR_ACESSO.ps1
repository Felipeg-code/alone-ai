$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
Write-Host ''
Write-Host '=== Alone.AI - Recuperacao de acesso ===' -ForegroundColor Cyan
Write-Host 'Nao apaga CRM, mensagens, configuracoes ou WhatsApp.' -ForegroundColor Yellow
Write-Host 'Recria somente o Gestor com PIN temporario 123456.' -ForegroundColor Yellow
Write-Host ''
$answer = Read-Host 'Digite RESETAR para continuar'
if ($answer -ne 'RESETAR') { Write-Host 'Cancelado.'; exit 0 }

# Encerra qualquer servidor Alone na porta 3333. Isso também elimina bloqueios de login e sessões em memória.
try {
  $conns = Get-NetTCPConnection -LocalPort 3333 -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    if ($c.OwningProcess) {
      Write-Host "Encerrando processo na porta 3333 (PID $($c.OwningProcess))..."
      Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  }
} catch {}
Start-Sleep -Seconds 1

$dataDir = Join-Path $root 'data'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$agents = Join-Path $dataDir 'agents.json'
if (Test-Path $agents) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Copy-Item $agents (Join-Path $dataDir "agents.backup-$stamp.json") -Force
}

# O servidor recebe este flag somente nesta execução e grava o hash correto por conta própria.
$env:ALONE_RESET_ACCESS = '1'
Write-Host 'Iniciando Alone em modo de recuperacao...' -ForegroundColor Cyan
& (Join-Path $root 'INSTALAR_E_INICIAR.ps1')
$code = $LASTEXITCODE
Remove-Item Env:ALONE_RESET_ACCESS -ErrorAction SilentlyContinue
if ($code -ne 0) { throw "Falha ao iniciar Alone em modo de recuperacao (codigo $code)." }

# Validação real: testa o mesmo endpoint usado pela tela de login.
$ok = $false
for ($i=0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $body = @{ agentId = 1; pin = '123456' } | ConvertTo-Json
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:3333/api/agents/login' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 3
    if ($r.token) { $ok = $true; break }
  } catch {}
}

Write-Host ''
if (-not $ok) {
  Write-Host 'ERRO: o reset foi executado, mas o login 123456 nao passou na validacao do backend.' -ForegroundColor Red
  Write-Host 'Envie o arquivo logs\server-error.log para diagnostico.' -ForegroundColor Yellow
  Read-Host 'Pressione ENTER para fechar' | Out-Null
  exit 1
}
Write-Host 'ACESSO VALIDADO PELO BACKEND.' -ForegroundColor Green
Write-Host 'Usuario: Gestor' -ForegroundColor Green
Write-Host 'PIN:     123456' -ForegroundColor Green
Write-Host ''
Write-Host 'Se o navegador estava aberto antes, pressione Ctrl+F5 na tela de login.' -ForegroundColor Cyan
Read-Host 'Pressione ENTER para fechar esta janela' | Out-Null
