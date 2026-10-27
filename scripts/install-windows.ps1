# Premiere Connector installer for Windows (run through install.bat).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Build = Join-Path $Root "build"
$ExtId = "com.premiereconnector"
$ExtDir = Join-Path $env:APPDATA "Adobe\CEP\extensions\$ExtId"
$ZxpUrl = "https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/ZXPSignCMD/4.1.103/win64/ZXPSignCmd.exe"
$CertPass = "premiere-connector"

function Step($t) { Write-Host "`n$t" -ForegroundColor White }
function Ok($t) { Write-Host "  [OK] $t" -ForegroundColor Green }

Step "1/6  Checking Node.js"
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js 18+ is required. Install it from https://nodejs.org and run this again." }
$major = [int](& $node -p "process.versions.node.split('.')[0]")
if ($major -lt 18) { throw "Node.js 18+ is required." }
Ok "node at $node"

Step "2/6  Building the MCP server"
Set-Location $Root
if (-not (Test-Path "config.json")) { Copy-Item "config.example.json" "config.json"; Ok "created config.json" }
& npm install --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE) { throw "npm install failed" }
& npm run build --silent
if ($LASTEXITCODE) { throw "build failed" }
Ok "built dist\server.js"

Step "3/6  Signing the Premiere panel"
New-Item -ItemType Directory -Force $Build | Out-Null
$Sign = Join-Path $Build "ZXPSignCmd.exe"
if (-not (Test-Path $Sign)) { Invoke-WebRequest -UseBasicParsing $ZxpUrl -OutFile $Sign }
$Cert = Join-Path $Build "selfsigned.p12"
if (-not (Test-Path $Cert)) { & $Sign -selfSignedCert US CA "Premiere Connector" "Premiere Connector" $CertPass $Cert | Out-Null }
$Stage = Join-Path $Build "stage"
$Zxp = Join-Path $Build "$ExtId.zxp"
Remove-Item -Recurse -Force $Stage, $Zxp -ErrorAction SilentlyContinue
Copy-Item -Recurse (Join-Path $Root "cep") $Stage
Remove-Item -Force (Join-Path $Stage ".debug") -ErrorAction SilentlyContinue
& $Sign -sign $Stage $Zxp $Cert $CertPass | Out-Null
if ($LASTEXITCODE) { throw "signing failed" }
Ok "signed build\$ExtId.zxp"

Step "4/6  Installing the panel into Premiere Pro"
if (Test-Path $ExtDir) {
  $item = Get-Item $ExtDir -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { cmd /c rmdir "$ExtDir" } else { Remove-Item -Recurse -Force $ExtDir }
}
New-Item -ItemType Directory -Force $ExtDir | Out-Null
$ZipCopy = Join-Path $Build "$ExtId.zip"
Copy-Item -Force $Zxp $ZipCopy
Expand-Archive -Force $ZipCopy $ExtDir
Remove-Item $ZipCopy
Ok "installed to $ExtDir"

Step "5/6  Registering with Claude"
$Server = (Join-Path $Root "dist\server.js") -replace "\\", "/"
$NodeJson = $node -replace "\\", "/"
if (Get-Command claude -ErrorAction SilentlyContinue) {
  & claude mcp remove premiere-connector -s user 2>$null | Out-Null
  & claude mcp add premiere-connector -s user -- $NodeJson $Server | Out-Null
  Ok "Claude Code (user scope)"
} else { Write-Host "  - Claude Code CLI not found, skipped" }

$DesktopCfg = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
if (Test-Path (Split-Path $DesktopCfg)) {
  & $node -e "const fs=require('fs');const [f,n,s]=process.argv.slice(1);let c={};try{c=JSON.parse(fs.readFileSync(f,'utf8'))}catch{};c.mcpServers=c.mcpServers||{};c.mcpServers['premiere-connector']={command:n,args:[s]};fs.writeFileSync(f,JSON.stringify(c,null,2)+'\n')" $DesktopCfg $NodeJson $Server
  Ok "Claude Desktop"
} else { Write-Host "  - Claude Desktop not found, skipped" }

Step "6/6  Installing the skill"
$SkillDir = Join-Path $env:USERPROFILE ".claude\skills\premiere-connector"
New-Item -ItemType Directory -Force -Path $SkillDir | Out-Null
Copy-Item (Join-Path $Root "skill\premiere-connector\SKILL.md") (Join-Path $SkillDir "SKILL.md") -Force
Ok "Claude Code skill in $SkillDir"

Write-Host @"

Done. Next:
  1. Restart Premiere Pro
  2. Open  Window > Extensions > Premiere Connector
  3. Restart Claude Code / Claude Desktop and ask Claude to edit your sequence.
"@
