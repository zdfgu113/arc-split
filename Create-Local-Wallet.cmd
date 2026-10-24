@echo off
"%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" -NoProfile -STA -File "%~dp0scripts\Create-LocalWallet.ps1"
