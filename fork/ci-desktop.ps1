# Baut die Windows-Desktop-App des Forks (x64, NSIS) auf dem TeamCity-Agenten winbuild01.
# Ergebnis liegt in release\. Unsigniert und ohne Update-Feed, sucht also nicht nach offiziellen
# Updates. Voraussetzungen auf dem Agenten: winbuild01/setup/06-t3code-tools.ps1 im cloud-Repo.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Invoke-Checked {
  & $args[0] @($args | Select-Object -Skip 1)
  if ($LASTEXITCODE -ne 0) { throw "$($args -join ' ') failed with $LASTEXITCODE" }
}

# Vite+ liegt agent-lokal; es wählt Node aus engines.node in package.json.
if (-not $env:VP_HOME) {
  $toolsDir = if ($env:AGENT_TOOLS_DIR) { $env:AGENT_TOOLS_DIR } else { "$env:LOCALAPPDATA" }
  $env:VP_HOME = Join-Path $toolsDir 't3code-vite-plus'
}
$env:VP_NODE_MANAGER = 'yes'
$env:CI = 'true'
if (-not (Test-Path (Join-Path $env:VP_HOME 'bin\vp.exe'))) {
  Invoke-RestMethod https://vite.plus/ps1 | Invoke-Expression
}
$env:Path = "$(Join-Path $env:VP_HOME 'bin');$env:Path"
Invoke-Checked vp env install
Invoke-Checked vp env exec node --version

if (-not (Test-Path .env)) { Copy-Item .env.example .env }
Remove-Item Env:T3CODE_DESKTOP_UPDATE_REPOSITORY, Env:GITHUB_REPOSITORY, Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force release -ErrorAction SilentlyContinue

Invoke-Checked vp install --filter=@t3tools/desktop... --filter=t3... --filter=@t3tools/scripts...
Invoke-Checked vp env exec node scripts/build-desktop-artifact.ts --platform win --target nsis --arch x64

Get-ChildItem release
