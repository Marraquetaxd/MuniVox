# Código fuente de MuniVox

Esta carpeta contendrá el código de la plataforma cuando se cierre la versión final:

| Carpeta | Descripción |
|---|---|
| `munivox-dashboard/` | Aplicación Next.js con los paneles C4, Departamentos y Terreno |
| `munivox-lambda/` | API REST (AWS Lambda + API Gateway) y avisos de WhatsApp |
| `webhook-service/` | Recepción de mensajes de Meta (Azure Container Apps) |
| `worker-service/` | Conversación con el vecino e IA con Gemini (Azure Container Apps) |
| `socket-service/` | Tiempo real por WebSocket (Azure Container Apps) |
| `base-de-datos/` | Scripts SQL de cada versión del esquema (v3, v4, v5) |
| `docker-compose.yml` | Entorno local con Redis, PostgreSQL y los tres servicios |

Cada servicio incluye un `.env.example` con los nombres de sus variables. Los archivos `.env` con valores reales no se versionan.
