$ErrorActionPreference = "Stop"
$env:CHOKIDAR_USEPOLLING = "true"
$env:BROWSER = "none"
$wd = "c:\Users\hp\Desktop\sycle work\project"
Set-Location $wd
$out = "$wd\npm-dev-out.log"
$err = "$wd\npm-dev-err.log"
if (Test-Path $out) { Remove-Item $out -Force }
if (Test-Path $err) { Remove-Item $err -Force }
$p = Start-Process -FilePath "npm.cmd" `
  -ArgumentList "run dev" `
  -WorkingDirectory $wd `
  -WindowStyle Hidden `
  -RedirectStandardOutput $out `
  -RedirectStandardError $err `
  -PassThru
$p.Id | Out-File -FilePath "$wd\npm-dev.pid" -Encoding ascii
Write-Output ("NPM_DEV_PID=" + $p.Id)