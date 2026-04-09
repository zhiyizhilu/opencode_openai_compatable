@echo off
chcp 65001 > nul
echo ============================================
echo OpenAI compatible OpenCode API Server
echo ============================================
echo.

REM Check if dependencies are installed
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo Failed to install dependencies
        pause
        exit /b 1
    )
    echo Dependencies installed
    echo.
)

REM Start server
echo Starting server...
echo Default port: 4094
echo.
call npm start

REM If server exits with error, pause to show error message
if errorlevel 1 (
    echo.
    echo Server failed to start
    pause
)
