$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Runtime = Join-Path $Root '.runtime'
$NodeHome = Join-Path $Runtime 'node'
$NodeExe = Join-Path $NodeHome 'node.exe'
$NpmCmd = Join-Path $NodeHome 'npm.cmd'
$AppDir = Join-Path $Root 'codigo-fonte-dev'
$PackageJson = Join-Path $AppDir 'package.json'
$NodeModules = Join-Path $AppDir 'node_modules'
$VersionFile = Join-Path $Runtime 'app-version.txt'
$InstanceFile = Join-Path $Runtime 'instance-id.txt'
$LogDir = Join-Path $Root 'logs'
$BootstrapLog = Join-Path $LogDir 'bootstrap.log'
$NodeVersion = '22.16.0'
$NodeZipUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
$NodeZip = Join-Path $Runtime 'node.zip'
$NodeExtract = Join-Path $Runtime 'node-extract'
$GitHome = Join-Path $Runtime 'git'
$GitCmdDir = Join-Path $GitHome 'cmd'
$GitExe = Join-Path $GitCmdDir 'git.exe'
$GitZip = Join-Path $Runtime 'mingit.zip'
$GitExtract = Join-Path $Runtime 'git-extract'
$ActiveNodeExe = $null
$ActiveNpmCmd = $null
$ActiveNodeHome = $null
$ActiveGitExe = $null

New-Item -ItemType Directory -Force -Path $Runtime, $LogDir | Out-Null
if (-not (Test-Path $InstanceFile)) { [guid]::NewGuid().ToString() | Set-Content -Path $InstanceFile -Encoding ASCII }
$InstanceId = (Get-Content $InstanceFile -Raw).Trim()
$env:ALONE_INSTANCE_ID = $InstanceId
function Log($msg) {
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
  Add-Content -Path $BootstrapLog -Value $line -Encoding UTF8
  Write-Host $msg
}

try {
  Log 'Alone.AI - inicializacao conectada'

  if (-not (Test-Path $PackageJson)) { throw "package.json nao encontrado em $PackageJson" }

  # 1) Prefere Node/npm ja instalados no Windows. So baixa runtime portatil se faltar.
  $SystemNode = Get-Command node.exe -ErrorAction SilentlyContinue
  $SystemNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  $UseSystemNode = $false

  if ($SystemNode -and $SystemNpm) {
    try {
      $systemNodeVersionRaw = (& $SystemNode.Source --version 2>$null).Trim().TrimStart('v')
      $systemNodeVersion = [version]$systemNodeVersionRaw
      if ($systemNodeVersion -ge [version]'22.13.0') {
        $UseSystemNode = $true
        $ActiveNodeExe = $SystemNode.Source
        $ActiveNpmCmd = $SystemNpm.Source
        $ActiveNodeHome = Split-Path -Parent $SystemNode.Source
        Log ("Node.js do sistema detectado: v" + $systemNodeVersionRaw + ". Download do Node portatil ignorado.")
      } else {
        Log ("Node.js do sistema detectado, mas versao v" + $systemNodeVersionRaw + " e inferior ao minimo suportado (22.13). Usando runtime portatil.")
      }
    } catch {
      Log 'Node.js do sistema foi encontrado, mas nao foi possivel validar a versao. Usando runtime portatil.'
    }
  } elseif ($SystemNode -and -not $SystemNpm) {
    Log 'Node.js encontrado no sistema, mas npm.cmd nao foi encontrado. Usando runtime portatil completo.'
  } else {
    Log 'Node.js/npm nao encontrados no sistema. Preparando runtime portatil.'
  }

  if (-not $UseSystemNode) {
    if (-not (Test-Path $NodeExe)) {
      Log "Primeiro uso: baixando Node.js portatil v$NodeVersion..."
      if (Test-Path $NodeZip) { Remove-Item $NodeZip -Force }
      if (Test-Path $NodeExtract) { Remove-Item $NodeExtract -Recurse -Force }
      New-Item -ItemType Directory -Force -Path $NodeExtract | Out-Null
      Invoke-WebRequest -Uri $NodeZipUrl -OutFile $NodeZip -UseBasicParsing
      Log 'Extraindo runtime...'
      Expand-Archive -Path $NodeZip -DestinationPath $NodeExtract -Force
      $Extracted = Get-ChildItem $NodeExtract -Directory | Select-Object -First 1
      if (-not $Extracted) { throw 'Falha ao extrair Node.js portatil.' }
      if (Test-Path $NodeHome) { Remove-Item $NodeHome -Recurse -Force }
      Move-Item $Extracted.FullName $NodeHome
      Remove-Item $NodeZip -Force -ErrorAction SilentlyContinue
      Remove-Item $NodeExtract -Recurse -Force -ErrorAction SilentlyContinue
    }

    if (-not (Test-Path $NpmCmd)) { throw 'npm.cmd nao foi encontrado no runtime portatil.' }
    $ActiveNodeExe = $NodeExe
    $ActiveNpmCmd = $NpmCmd
    $ActiveNodeHome = $NodeHome
    Log 'Usando Node.js portatil do Alone.'
  }

  # 2) Prefere Git ja instalado. So baixa MinGit quando git.exe nao estiver disponivel.
  $SystemGit = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($SystemGit) {
    $ActiveGitExe = $SystemGit.Source
    Log ('Git do sistema detectado: ' + $ActiveGitExe + '. Download do Git portatil ignorado.')
  } else {
    if (-not (Test-Path $GitExe)) {
      Log 'Git nao encontrado no sistema. Baixando Git portatil oficial (MinGit)...'
      if (Test-Path $GitZip) { Remove-Item $GitZip -Force }
      if (Test-Path $GitExtract) { Remove-Item $GitExtract -Recurse -Force }
      New-Item -ItemType Directory -Force -Path $GitExtract | Out-Null

      $headers = @{ 'User-Agent' = 'Alone-AI-Agent' }
      $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers $headers
      $asset = $release.assets | Where-Object { $_.name -match '^MinGit-.*-64-bit\.zip$' } | Select-Object -First 1
      if (-not $asset) { throw 'Nao foi possivel localizar o pacote MinGit 64-bit no Git for Windows.' }

      Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $GitZip -Headers $headers -UseBasicParsing
      Log ('Extraindo Git portatil: ' + $asset.name)
      Expand-Archive -Path $GitZip -DestinationPath $GitExtract -Force
      if (Test-Path $GitHome) { Remove-Item $GitHome -Recurse -Force }
      Move-Item $GitExtract $GitHome
      Remove-Item $GitZip -Force -ErrorAction SilentlyContinue

      if (-not (Test-Path $GitExe)) { throw 'Git portatil foi baixado, mas git.exe nao foi encontrado.' }
      Log 'Git portatil preparado.'
    }
    $ActiveGitExe = $GitExe
    Log 'Usando Git portatil do Alone.'
  }

  # Monta PATH temporario apenas com o necessario para esta execucao.
  $ActiveGitCmdDir = Split-Path -Parent $ActiveGitExe
  $env:PATH = "$ActiveNodeHome;$ActiveGitCmdDir;$env:PATH"

  # Verificacao final: evita descobrir so no meio do npm install que algo esta faltando.
  & $ActiveNodeExe --version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Node.js selecionado nao respondeu corretamente.' }
  & $ActiveNpmCmd --version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'npm selecionado nao respondeu corretamente.' }
  & $ActiveGitExe --version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Git selecionado nao respondeu corretamente.' }

  $pkg = Get-Content $PackageJson -Raw | ConvertFrom-Json
  $AppVersion = [string]$pkg.version
  $InstalledVersion = if (Test-Path $VersionFile) { (Get-Content $VersionFile -Raw).Trim() } else { '' }
  $NeedInstall = (-not (Test-Path $NodeModules)) -or ($InstalledVersion -ne $AppVersion)

  if ($NeedInstall) {
    Log "Preparando dependencias do Alone.AI v$AppVersion..."
    Push-Location $AppDir
    try {
      & $ActiveNpmCmd ci --omit=dev --no-audit --no-fund --loglevel=error
      if ($LASTEXITCODE -ne 0) { throw "npm ci falhou com codigo $LASTEXITCODE" }
    } finally { Pop-Location }
    Set-Content -Path $VersionFile -Value $AppVersion -Encoding ASCII
    Log 'Dependencias preparadas.'
  } else {
    Log 'Ambiente ja preparado. Pulando instalacao.'
  }

  # Só reutiliza servidor se ele pertencer EXATAMENTE a esta instalação.
  try {
    $alive = Invoke-WebRequest -Uri 'http://127.0.0.1:3333/api/public-config' -UseBasicParsing -TimeoutSec 2
    if ($alive.StatusCode -eq 200) {
      $cfg = $alive.Content | ConvertFrom-Json
      if ([string]$cfg.instanceId -eq $InstanceId) {
        Log 'Esta mesma instalação do Alone.AI ja esta em execucao. Abrindo painel.'
        Start-Process 'http://127.0.0.1:3333'
        exit 0
      }
      Log ('Outra instancia do Alone esta usando a porta 3333 (instancia ' + [string]$cfg.instanceId + '). Encerrando processo antigo...')
      try {
        $listeners = Get-NetTCPConnection -LocalPort 3333 -State Listen -ErrorAction Stop
        foreach($listener in $listeners){ if($listener.OwningProcess){ Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue } }
        Start-Sleep -Milliseconds 800
      } catch { throw 'Existe outro servidor na porta 3333 e nao foi possivel encerra-lo automaticamente. Feche a versao antiga do Alone e tente novamente.' }
    }
  } catch {
    if ($_.Exception.Message -like 'Existe outro servidor*') { throw }
  }

  # Preflight real do runtime depois do npm ci. Se uma dependência estiver ausente/corrompida,
  # falhamos aqui com a causa exata em vez de esperar 60 segundos por uma porta que nunca abrirá.
  Push-Location $AppDir
  try {
    & $ActiveNodeExe -e "require('dotenv');require('express');require('pino');require('qrcode');require('@whiskeysockets/baileys');console.log('runtime-ok')" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'As dependencias foram instaladas, mas o runtime nao conseguiu carrega-las. Execute novamente o instalador.' }
  } finally { Pop-Location }

  # Porta preferencial 3333; se ficou presa por outra aplicação/processo, usa a próxima livre.
  $Port = 3333
  for($candidate=3333; $candidate -le 3343; $candidate++) {
    $busy=$false
    try { $busy = @(Get-NetTCPConnection -LocalPort $candidate -State Listen -ErrorAction Stop).Count -gt 0 } catch { $busy=$false }
    if(-not $busy) { $Port=$candidate; break }
  }
  $env:PORT = [string]$Port
  $env:HOST = '127.0.0.1'
  if($Port -ne 3333) { Log ("Porta 3333 ocupada. Usando porta $Port.") }

  Log 'Iniciando Alone.AI...'
  $stdout = Join-Path $LogDir 'server-out.log'
  $stderr = Join-Path $LogDir 'server-error.log'
  if(Test-Path $stdout){Remove-Item $stdout -Force -ErrorAction SilentlyContinue}
  if(Test-Path $stderr){Remove-Item $stderr -Force -ErrorAction SilentlyContinue}
  $serverProcess = Start-Process -FilePath $ActiveNodeExe -ArgumentList 'server/index.js' -WorkingDirectory $AppDir -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

  $Ready = $false
  for ($i=0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    if($serverProcess.HasExited) {
      $detail=''
      if(Test-Path $stderr) { $detail=(Get-Content $stderr -Tail 35 -ErrorAction SilentlyContinue) -join [Environment]::NewLine }
      if(-not $detail -and (Test-Path $stdout)) { $detail=(Get-Content $stdout -Tail 35 -ErrorAction SilentlyContinue) -join [Environment]::NewLine }
      Log ("ERRO: processo do servidor encerrou com codigo $($serverProcess.ExitCode).")
      if($detail) { Write-Host ''; Write-Host 'ERRO REAL DO SERVIDOR:' -ForegroundColor Yellow; Write-Host $detail -ForegroundColor Yellow; Add-Content -Path $BootstrapLog -Value $detail -Encoding UTF8 }
      throw 'O servidor encerrou durante a inicializacao. O erro real foi exibido acima.'
    }
    try {
      $r = Invoke-WebRequest -Uri ("http://127.0.0.1:$Port/api/public-config") -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200) { $Ready = $true; break }
    } catch {}
  }

  if (-not $Ready) {
    $detail=''
    if(Test-Path $stderr) { $detail=(Get-Content $stderr -Tail 35 -ErrorAction SilentlyContinue) -join [Environment]::NewLine }
    Log ("ERRO: servidor nao respondeu na porta $Port.")
    if($detail) { Write-Host ''; Write-Host 'ULTIMAS LINHAS DO SERVIDOR:' -ForegroundColor Yellow; Write-Host $detail -ForegroundColor Yellow; Add-Content -Path $BootstrapLog -Value $detail -Encoding UTF8 }
    throw "O Alone nao iniciou. Consulte $stderr"
  }

  Log ("Alone.AI pronto na porta $Port. Abrindo navegador.")
  Start-Process ("http://127.0.0.1:$Port")
  exit 0
}
catch {
  Log ("ERRO: " + $_.Exception.Message)
  Write-Host ''
  Write-Host 'Nao foi possivel iniciar o Alone.AI.' -ForegroundColor Red
  Write-Host "Veja o diagnostico em: $BootstrapLog"
  Write-Host 'Pressione ENTER para fechar.'
  Read-Host | Out-Null
  exit 1
}
