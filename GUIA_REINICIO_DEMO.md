# Guía mínima de reinicio (Joao)

## Arranque diario (un solo comando)
1. Abre PowerShell en `G:\OneDrive\OneDrive - Crosland\perfil de windows\Documents\mi-proyecto`
2. Ejecuta:

```powershell
.\start-demo.ps1
```

Ese script hace todo:
- inicia Docker Desktop si está apagado
- levanta contenedores (`docker compose up -d`)
- levanta ngrok
- valida rutas públicas
- imprime URLs finales de demo

## Si apagas y prendes la máquina
1. Espera a que Windows termine de cargar.
2. Abre PowerShell en la carpeta del proyecto.
3. Ejecuta `.\start-demo.ps1`
4. Usa las URLs que el script imprime al final.

## Estabilidad de rutas
- Rutas locales: **sí se mantienen** (puertos locales siguen iguales).
  - chat interno: `http://localhost:8080`
  - servicedesk interno: `http://localhost:8081`
  - repository interno: `http://localhost:8082`
  - api interna: `http://localhost:8001`
  - n8n interno: `http://localhost:5678`
- URL pública de ngrok: **puede cambiar en cada reinicio** del túnel (plan free).
- ¿Hay que editar archivos cada vez?: **no**. El flujo quedó preparado para reutilizar el mismo dominio/rutas públicas sin tocar diseño ni features.

