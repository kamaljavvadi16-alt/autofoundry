@echo off
cd /d %~dp0
echo Starting AutoFoundry (dashboard + work daemon)...
start "" http://localhost:4321
npm run --silent foundry -- serve -p 4321 --daemon
