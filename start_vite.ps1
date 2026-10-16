$ErrorActionPreference = "Stop"
$env:CHOKIDAR_USEPOLLING = "true"
$env:BROWSER = "none"
$wd = "c:\Users\hp\Desktop\sycle work\project"
Set-Location $wd
if (Test-Path "$wd\vite-out.log") { Remove-Item "$wd\vite-out.log" -Force }
if (Test-Path "$wd\vite-err.log") { Remove-Item "$wd\vite-err.log" -Force }
$p = Start-Process -FilePath "node.exe" `
  -ArgumentList "node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4180" `
  -WorkingDirectory $wd `
  -WindowStyle Hidden `
  -RedirectStandardOutput "$wd\vite-out.log" `
  -RedirectStandardError "$wd\vite-err.log" `
  -PassThru
$p.Id | Out-File -FilePath "$wd\vite.pid" -Encoding ascii
Write-Output ("VITE_PID=" + $p.Id)