# MuniVox — Gestión Inteligente de Incidencias Urbanas con IA y WhatsApp

Plataforma que convierte los reportes ciudadanos enviados por WhatsApp en tickets estructurados y georreferenciados para la Central de Comunicaciones (C4) de la Municipalidad de Buin. Un agente de Inteligencia Artificial (Google Gemini) conversa con el ciudadano, clasifica el reporte y exige ubicación y evidencia; el ticket llega en tiempo real a los dashboards del Operador C4 y de los Departamentos, se despacha a un funcionario en terreno y el ciudadano recibe un aviso de WhatsApp en cada cambio de estado.

Proyecto de Título (Capstone, PTY4614) — Alonso Campusano y Pablo Vargas. Duoc UC, Ingeniería Informática.

## Tabla de contenidos

- [Descripción](#descripción)
- [Tecnologías](#tecnologías)
- [Arquitectura](#arquitectura)
- [Estructura del repositorio](#estructura-del-repositorio)
- [Ejecución local](#ejecución-local)
- [Despliegue](#despliegue)
- [Integrantes y roles](#integrantes-y-roles)
- [Metodología](#metodología)
- [Modelo de datos](#modelo-de-datos)
- [Diagramas](#diagramas)
- [Documentación adicional](#documentación-adicional)

## Descripción

La gestión de incidencias urbanas (baches, microbasurales, luminarias, ruidos, vehículos abandonados) está fragmentada: los reportes llegan por redes sociales, llamadas o correos, casi siempre sin ubicación ni foto; una persona debe leer, interpretar y derivar cada caso a mano; y el ciudadano queda sin información sobre el avance de su solicitud. MuniVox resuelve esto con el siguiente flujo:

1. **Reporte.** El ciudadano escribe por WhatsApp al número central del C4, con texto, foto o ubicación.
2. **Triaje con IA.** Gemini clasifica el reporte, descarta duplicados, evidencia inválida y solicitudes ajenas al municipio, exige la ubicación y deriva las emergencias vitales a los números 131, 132 y 133.
3. **Ticket.** Se crea un ticket georreferenciado (estado `PENDIENTE`) con su evidencia guardada en S3.
4. **Gestión.** El Operador C4 lo ve en tiempo real en el mapa 3D y lo deriva al departamento correspondiente (`EN_REVISION`), donde la jefatura asigna un funcionario.
5. **Terreno.** El funcionario acepta la tarea desde la App de Terreno (PWA), navega con Waze o Google Maps (`DESPACHADO`) y cierra el caso con un código de confirmación (`RESUELTO`).
6. **Aviso al ciudadano.** Cada cambio de estado se informa automáticamente por WhatsApp.

## Tecnologías

| Capa | Tecnologías |
|---|---|
| Ingesta y procesamiento | Node.js, Express, BullMQ, ioredis, Docker (Azure Container Apps) |
| Inteligencia Artificial | Google Gemini 3.5 Flash Lite (multimodal, respuesta JSON) |
| Tiempo real | Redis Pub/Sub, Socket.IO |
| API y notificaciones | AWS API Gateway + Lambda (Node.js), Graph API de Meta (WhatsApp Cloud API) |
| Datos | PostgreSQL (AWS RDS), Prisma ORM, AWS S3 (evidencias), Redis (AWS ElastiCache) |
| Identidad | AWS Cognito, NextAuth |
| Frontend | Next.js, React, TypeScript, Mapbox GL, AWS Amplify |
| Navegación en terreno | Enlaces profundos a Waze y Google Maps |

## Arquitectura

Arquitectura orientada a eventos y microservicios, en cuatro capas:

1. **Presentación** (AWS Amplify): Dashboard Operador C4, Dashboard Departamentos y App de Terreno (PWA), en una única aplicación Next.js.
2. **API, identidad y tiempo real**: AWS Cognito, API Gateway + Lambda y `socket-service`.
3. **Ingesta y procesamiento** (Azure Container Apps): `webhook-service` y `worker-service`.
4. **Datos y almacenamiento** (AWS): PostgreSQL (RDS), Redis (ElastiCache) y S3.

Flujo de un mensaje: Meta entrega el mensaje al `webhook-service`, que responde `200` de inmediato y lo encola en Redis (BullMQ). El `worker-service` toma el trabajo, descarta duplicados, consulta a Gemini, guarda la foto en S3, crea o actualiza el ticket en PostgreSQL y responde al ciudadano por WhatsApp. Luego publica el evento `nuevo-ticket` en Redis; el `socket-service`, suscrito a ese canal, lo reenvía por WebSocket a los dashboards. Los dashboards consumen la API REST (protegida por Cognito), y la Lambda avisa al ciudadano de cada cambio de estado.

Ver los diagramas completos en [Diagramas](#diagramas).

## Estructura del repositorio

| Carpeta | Descripción | Plataforma |
|---|---|---|
| `webhook-service/` | Recibe los webhooks de Meta y encola los mensajes (`server.js`). | Azure Container Apps |
| `worker-service/` | Triaje con IA, WhatsApp, evidencias y creación de tickets (`worker.js`, `prisma/`). | Azure Container Apps |
| `socket-service/` | Servidor WebSocket que reenvía los tickets nuevos a los dashboards (`server.js`). | Azure Container Apps |
| `lambda-rest-api/` | API REST de operadores y tickets, y avisos por WhatsApp (`index.js`, `prisma/`). | AWS Lambda + API Gateway |
| `munivox-dashboard/` | Aplicación Next.js con las tres interfaces (Operador C4, Departamentos y Terreno). | AWS Amplify |

## Ejecución local

Requisitos: Node.js 18 o superior, una instancia de Redis, una base de datos PostgreSQL y las credenciales de las APIs externas (Meta, Gemini, Mapbox, AWS). Los valores secretos nunca se versionan: se entregan por variables de entorno (archivo `.env` local en cada servicio).

### Variables de entorno

| Componente | Variables |
|---|---|
| `webhook-service` | `REDIS_HOST`, `META_VERIFY_TOKEN`, `PORT` (por defecto 8080) |
| `worker-service` | `REDIS_HOST`, `GEMINI_API_KEY`, `AWS_REGION` (por defecto `us-east-2`), `AWS_S3_BUCKET_NAME`, `META_PHONE_ID`, `META_ACCESS_TOKEN`, conexión de Prisma (`DATABASE_URL`) y credenciales de AWS |
| `socket-service` | `REDIS_HOST`, `FRONTEND_URL`, `PORT` (por defecto 3001) |
| `lambda-rest-api` | `META_PHONE_ID`, `META_ACCESS_TOKEN`, `DATABASE_URL` |
| `munivox-dashboard` | `NEXT_PUBLIC_API_GATEWAY_URL`, `NEXT_PUBLIC_MAPBOX_TOKEN` y la configuración de NextAuth y Cognito |

### Servicios de ingesta y tiempo real

```bash
# 1) Base de datos: generar el cliente de Prisma (desde worker-service/ o lambda-rest-api/)
npm install
npx prisma generate
npx prisma migrate deploy      # o: npx prisma db push

# 2) Webhook (puerto 8080)
cd webhook-service
npm install
node server.js

# 3) Worker de IA (consume la cola de Redis, sin puerto)
cd ../worker-service
npm install
node worker.js

# 4) Socket service (puerto 3001)
cd ../socket-service
npm install
node server.js
```

Para probar el webhook con Meta en local, exponer el puerto con un túnel HTTPS y registrar la URL `/api/webhook` con el token `META_VERIFY_TOKEN`.

### Dashboards (Next.js)

```bash
cd munivox-dashboard
npm install
npm run dev
```

Rutas: `/` (Operador C4), `/departamentos` (jefaturas), `/terreno` (funcionarios) y `/login`. La vista de cada usuario depende de su rol en Cognito.

## Despliegue

- **Azure Container Apps:** `webhook-service`, `worker-service` y `socket-service`, cada uno construido con su `Dockerfile`.
- **AWS Lambda + API Gateway:** `lambda-rest-api` (región `us-east-2`), con CORS restringido al dominio de Amplify.
- **AWS Amplify:** `munivox-dashboard`, con la compilación definida en `amplify.yml`.
- **AWS administrado:** ElastiCache (Redis), RDS (PostgreSQL), S3 y Cognito.

## Integrantes y roles

| Integrante | Rol principal |
|---|---|
| Alonso Campusano Lacoste | _(completar)_ |
| Pablo Vargas Soto | _(completar)_ |

Ambos integrantes participan en conjunto en las pruebas integrales y en la preparación de la presentación final.

## Metodología

El proyecto se desarrolla bajo una metodología ágil (Scrum adaptado a un equipo de dos integrantes), con 7 sprints alineados al plan de trabajo y a la Carta Gantt:

| Sprint | Semanas | Foco |
|---|---|---|
| 1 | 1-2 | Levantamiento |
| 2 | 2-5 | Diseño y arquitectura |
| 3 | 5-8 | Infraestructura cloud |
| 4 | 9-11 | Ingesta e IA |
| 5 | 12-13 | Dashboards |
| 6 | 14-16 | Pruebas y ajustes |
| 7 | 17-18 | Cierre y defensa |

Artefactos documentados: metodología declarada y justificada, Product Vision, Product Backlog, Sprint Backlog, Definition of Done y Retrospectivas.

## Modelo de datos

Siete entidades en PostgreSQL, definidas con Prisma (`schema.prisma`): **Ciudadano**, **Reporte** (ticket), **Categoría**, **Departamento**, **Operador**, **Evidencia** e **Historial de estados**.

Estados del ticket (`EstadoReporte`): `PENDIENTE`, `EN_REVISION`, `DESPACHADO`, `RESUELTO` y `DESCARTADO`. Todo cambio de estado queda registrado en el historial con operador, comentario y fecha.

## Diagramas

Los diagramas (fuente editable `.drawio` e imagen renderizada) están en la carpeta `docs/diagramas/`:

- Arquitectura 4+1 (versión formal y versión simple para presentación)
- Arquitectura del sistema
- Casos de uso
- Diagrama de estado (ciclo de vida del ticket y subestados de `PENDIENTE`)
- Diagrama de componentes

## Documentación adicional

- Documentación técnica integral: `docs/Documentacion_Tecnica_MuniVox.docx`
- Informes de Fase 1 y Fase 2 (definición, avance, final y autoevaluaciones): carpetas `Fase 1/` y `Fase 2/`
