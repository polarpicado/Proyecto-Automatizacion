# Guia minima de reinicio (Demo)

## Arranque diario (1 comando)

1. Abrir PowerShell en:
`G:\OneDrive\OneDrive - Crosland\perfil de windows\Documents\mi-proyecto`
2. Ejecutar:

```powershell
.\start-demo.ps1
```

El script realiza:

- validacion de Docker Desktop
- `docker compose up -d`
- reinicio de ngrok
- validacion de rutas publicas
- impresion de URLs finales

## Cuando se reinicia la maquina

1. Esperar a que Docker Desktop quede operativo.
2. Abrir PowerShell en la carpeta del proyecto.
3. Ejecutar `.\start-demo.ps1`.
4. Usar las URLs que imprime el script.

## Rutas locales estables

- chat: `http://localhost:8080`
- servicedesk: `http://localhost:8081`
- repository: `http://localhost:8082`
- api: `http://localhost:8001`
- n8n: `http://localhost:5678`
- qdrant: `http://localhost:6333`
- gateway: `http://localhost:8090`

## URLs publicas ngrok

- En plan free, cambian al reiniciar tunel.
- No es necesario editar frontend cada vez si se usa el gateway como entrada unica.

## Recomendacion operativa

- Usar gateway como base publica:
  - `https://<dominio-ngrok>/chat/`
  - `https://<dominio-ngrok>/servicedesk/`
  - `https://<dominio-ngrok>/repository/`
  - `https://<dominio-ngrok>/api/health`
  - `https://<dominio-ngrok>/n8n/`
