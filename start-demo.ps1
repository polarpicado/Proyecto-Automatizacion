param(
    [string]$ProjectRoot = $PSScriptRoot
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host "[DEMO] $Message" -ForegroundColor Cyan
}

function Wait-Docker {
    param([int]$TimeoutSeconds = 180)
    $started = Get-Date
    while (((Get-Date) - $started).TotalSeconds -lt $TimeoutSeconds) {
        try {
            docker info | Out-Null
            return $true
        } catch {
            Start-Sleep -Seconds 2
        }
    }
    return $false
}

function Ensure-DockerDesktop {
    Write-Step "Verificando Docker..."
    if (Wait-Docker -TimeoutSeconds 5) {
        Write-Step "Docker ya está disponible."
        return
    }

    $dockerDesktopExe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (-not (Test-Path $dockerDesktopExe)) {
        throw "No encontré Docker Desktop en: $dockerDesktopExe"
    }

    Write-Step "Iniciando Docker Desktop..."
    Start-Process -FilePath $dockerDesktopExe | Out-Null

    if (-not (Wait-Docker -TimeoutSeconds 180)) {
        throw "Docker Desktop no quedó listo dentro del tiempo esperado."
    }

    Write-Step "Docker listo."
}

function Start-Project {
    Write-Step "Levantando contenedores con docker compose..."
    docker compose up -d | Out-Host
    Write-Step "Contenedores arriba."
}

function Start-NgrokGateway {
    param([string]$GatewayPort = "8090")

    Write-Step "Reiniciando ngrok para un túnel limpio..."
    Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1

    Start-Process -FilePath ngrok -ArgumentList @("http", $GatewayPort, "--log", "stdout") -WindowStyle Hidden | Out-Null

    $publicUrl = $null
    $started = Get-Date
    while (((Get-Date) - $started).TotalSeconds -lt 30) {
        try {
            $tunnels = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels"
            if ($tunnels.tunnels.Count -gt 0) {
                $publicUrl = $tunnels.tunnels[0].public_url
                break
            }
        } catch {
            Start-Sleep -Milliseconds 700
        }
        Start-Sleep -Milliseconds 400
    }

    if (-not $publicUrl) {
        throw "No se pudo obtener la URL pública de ngrok."
    }

    return $publicUrl
}

function Test-PublicRoutes {
    param([string]$BaseUrl)

    Write-Step "Validando rutas públicas..."
    $headers = @{ "ngrok-skip-browser-warning" = "true" }
    $checks = @(
        "$BaseUrl/chat/",
        "$BaseUrl/servicedesk/",
        "$BaseUrl/repository/",
        "$BaseUrl/api/health",
        "$BaseUrl/n8n"
    )

    foreach ($url in $checks) {
        $res = Invoke-WebRequest -Uri $url -Headers $headers -UseBasicParsing -TimeoutSec 25
        if ($res.StatusCode -lt 200 -or $res.StatusCode -ge 400) {
            throw "Falló validación en $url (status $($res.StatusCode))."
        }
    }

    Write-Step "Rutas públicas OK."
}

Push-Location $ProjectRoot
try {
    Ensure-DockerDesktop
    Start-Project
    $base = Start-NgrokGateway
    Test-PublicRoutes -BaseUrl $base

    $urls = [ordered]@{
        chat        = "$base/chat/"
        servicedesk = "$base/servicedesk/"
        repository  = "$base/repository/"
        api         = "$base/api"
        n8n         = "$base/n8n"
    }

    Write-Host ""
    Write-Host "===== URLS PUBLICAS =====" -ForegroundColor Green
    $urls.GetEnumerator() | ForEach-Object {
        Write-Host ("{0}: {1}" -f $_.Key, $_.Value)
    }
    Write-Host "=========================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Listo para demo."
} finally {
    Pop-Location
}
