@echo off
title Despacho
echo === Despacho - Iniciando ===

cd /d "%~dp0backend"
call node scripts/ensure-db.mjs
if errorlevel 1 exit /b 1

call npx prisma db push
if errorlevel 1 exit /b 1

start "Despacho API" cmd /k "cd /d %~dp0backend && npm run dev"
timeout /t 3 /nobreak >nul
start "Despacho Web" cmd /k "cd /d %~dp0frontend && npm run dev"

echo.
echo Frontend: http://localhost:5173
echo Backend:  http://localhost:3001
echo Login:    admin@voceve.com / admin123
echo.
pause
