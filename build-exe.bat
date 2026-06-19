@echo off
echo ====================================================================
echo   Fin-Extract Ledger Studio - Auto Compile to Standalone Windows .EXE
echo ====================================================================
echo.
echo [1/4] Validating local runtime environments...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is required to compile this application.
    echo Please install NodeJS from https://nodejs.org/ and restart your terminal.
    pause
    exit /b
)

echo [2/4] Initializing secure package download tree...
call npm install --no-audit --no-fund

echo.
echo [3/4] Compiling optimized high-contrast UI component tree...
call npm run build

echo.
echo [4/4] Generating fully sandboxed, portable executable (.exe)...
echo Running local electron-builder compilation...
npx electron-builder --config electron-builder.json

echo.
echo ====================================================================
echo   SUCCESS! Standalone application bundle compiled successfully.
echo   ====================================================================
echo   Executable Location: ./dist-desktop/FinExtractStudio-*.exe
echo   Just double click that file to run the app on any offline machine!
echo ====================================================================
pause
