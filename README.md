# MuniVox — Gestión Inteligente de Incidencias Urbanas con IA y WhatsApp

Plataforma que convierte los reportes ciudadanos enviados por WhatsApp en tickets estructurados y georreferenciados para la Central de Comunicaciones (C4) de la Municipalidad de Buin. Un agente de inteligencia artificial (Google Gemini) conversa con el vecino, clasifica el reporte y exige la ubicación; el ticket llega en tiempo real a los paneles del Operador C4 y de los Departamentos, se asigna a un funcionario en terreno y el vecino recibe un aviso por WhatsApp en cada cambio de estado.

Proyecto de Título (Capstone PTY4614, sección 003D) — Alonso Campusano Lacoste y Pablo Vargas Soto. Duoc UC, Ingeniería en Informática, sede Antonio Varas.

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
- [Documentación del proyecto](#documentación-del-proyecto)

## Descripción

Los reclamos urbanos (baches, microbasurales, luminarias, ruidos, vehículos abandonados, áreas verdes, animales) llegan hoy por redes sociales, llamadas o correos, casi siempre sin ubicación ni foto; alguien debe leerlos y derivarlos a mano, y el vecino no sabe cómo avanza su caso. MuniVox ordena ese proceso:

1. **Reporte.** El vecino escribe por WhatsApp. Un menú con botones lo guía; describe el problema, envía una foto (opcional) y su ubicación GPS.
2. **Triaje con IA.** Gemini clasifica la categoría, el departamento y la prioridad. Un detector de intención distingue consultas ("¿qué reportes tengo?") de reportes nuevos. Las emergencias vitales se derivan a 131, 132 y 133.
3. **Ticket.** Con una ubicación dentro de Buin, el reporte se confirma (`PENDIENTE`) y el vecino recibe un código `MUN-` y un enlace de seguimiento.
4. **Gestión.** El Operador C4 lo ve en el mapa en tiempo real y lo deriva (`EN_REVISION`); la jefatura del departamento lo asigna a un funcionario.
5. **Terreno.** El funcionario toma el caso desde la app web (`DESPACHADO`), avisa que va en camino y lo cierra con un informe y una foto (`RESUELTO`).
6. **Aviso al vecino.** Cada cambio se informa por WhatsApp; al cierre, el vecino evalúa la atención.

## Tecnologías

| Capa | Tecnologías |
|---|---|
| Ingesta y procesamiento | Node.js 20, Express, BullMQ, ioredis, Docker (Azure Container Apps) |
| Inteligencia artificial | Google Gemini (multimodal, respuesta JSON) |
| Tiempo real | Redis Pub/Sub, Socket.IO |
| API y notificaciones | AWS API Gateway + Lambda (Node.js), WhatsApp Cloud API (Meta Graph v18), Web Push |
| Datos | PostgreSQL (AWS RDS), Prisma 5.22, AWS S3, Redis (AWS ElastiCache) |
| Identidad | AWS Cognito, NextAuth v4 |
| Frontend | Next.js 16, React 19, TypeScript, Mapbox GL, recharts, AWS Amplify |

## Arquitectura

Arquitectura orientada a eventos y microservicios, en cuatro capas:

1. **Presentación** (AWS Amplify): Panel Operador C4, Panel Departamentos, App de Terreno (PWA) y páginas públicas de seguimiento y privacidad, en una sola aplicación Next.js.
2. **API, identidad y tiempo real**: AWS Cognito, API Gateway + Lambda y `socket-service`.
3. **Ingesta y procesamiento** (Azure Container Apps): `webhook-service` y `worker-service`.
4. **Datos** (AWS): PostgreSQL (RDS), Redis (ElastiCache) y S3.

Flujo de un mensaje: Meta entrega el mensaje al `webhook-service`, que valida la firma, responde `200` y lo encola en Redis (BullMQ). El `worker-service` consulta a Gemini, guarda la foto en S3, crea o actualiza el reporte en PostgreSQL y responde al vecino. Luego publica `nuevo-ticket` en Redis y el `socket-service` lo reenvía a los paneles por WebSocket. Los paneles usan la API REST protegida por Cognito, y la Lambda avisa al vecino de cada cambio de estado.

![Arquitectura](Fase%202/Evidencias%20Proyecto/Diagramas/MuniVox_Arquitectura.png)

## Estructura del repositorio

```
MuniVox/
├── Fase 1/
│   ├── Evidencias Individuales/      autoevaluaciones y diarios 1.1, 1.2, 1.3 de cada integrante
│   └── Evidencias Grupales/          1.4, 1.5, planilla de evaluación y presentación
├── Fase 2/
│   ├── Evidencias Individuales/      diario de reflexión 2.1 de cada integrante
│   ├── Evidencias Grupales/          2.2, 2.3, 2.4, 2.6 y planillas de avance y final
│   └── Evidencias Proyecto/
│       ├── Metodologia/              metodología, Product Vision, backlogs, DoD y retrospectivas
│       ├── Requisitos/               requisitos funcionales y no funcionales
│       ├── Diagramas/                4+1, arquitectura, casos de uso, componentes, estados, clases y secuencia
│       ├── Modelo de Datos/          modelo entidad-relación, diccionario de datos y schema.prisma
│       ├── Pruebas/                  plan y casos de prueba
│       ├── Manual Tecnico/           manual técnico y manual de usuario
│       ├── Innovacion/               innovación del proyecto
│       ├── Codigo/                   código fuente de la plataforma
│       └── MuniVox.pptx
└── Fase 3/
    ├── Evidencias Individuales/      diario 3.1 y autoevaluación 3.2 de cada integrante
    └── Evidencias Grupales/          presentación final y planilla de evaluación
```

| Carpeta de código (`Fase 2/Evidencias Proyecto/Codigo/`) | Descripción | Plataforma |
|---|---|---|
| `webhook-service/` | Recibe los webhooks de Meta y encola los mensajes | Azure Container Apps |
| `worker-service/` | Conversación, IA, evidencias y creación de reportes | Azure Container Apps |
| `socket-service/` | WebSocket para los paneles | Azure Container Apps |
| `munivox-lambda/` | API REST y avisos por WhatsApp | AWS Lambda + API Gateway |
| `munivox-dashboard/` | Paneles C4, Departamentos y Terreno | AWS Amplify |

## Ejecución local

Requisitos: Node.js 20 o superior, Docker y las credenciales de las APIs externas (Meta, Gemini, Mapbox, AWS). Los valores secretos nunca se versionan: cada servicio trae un `.env.example` que se copia a `.env` y se completa.

```bash
# Redis, PostgreSQL y los tres microservicios
cd "Fase 2/Evidencias Proyecto/Codigo"
docker compose up --build

# Cliente de Prisma (desde worker-service/ o munivox-lambda/)
npm install
npx prisma generate

# Paneles (http://localhost:3000)
cd munivox-dashboard
npm install
npm run dev
```

Rutas: `/` (Operador C4), `/departamentos` (jefaturas), `/terreno` (funcionarios), `/login`, y las públicas `/seguimiento` y `/privacidad`. La vista depende del rol del usuario.

## Despliegue

- **Azure Container Apps:** `webhook-service`, `worker-service` y `socket-service`, con imágenes `munivoxacr2026.azurecr.io/<servicio>:vNN`.
- **AWS Lambda + API Gateway:** `munivox-lambda` (región `us-east-2`), con authorizer JWT de Cognito.
- **AWS Amplify:** `munivox-dashboard`, con la compilación definida en `amplify.yml`.
- **AWS administrado:** RDS (PostgreSQL), ElastiCache (Redis), S3 y Cognito.

El detalle está en el [Manual técnico](Fase%202/Evidencias%20Proyecto/Manual%20Tecnico/Manual_Tecnico_MuniVox.docx).

## Integrantes y roles

| Integrante | Rol Scrum | Responsabilidad principal |
|---|---|---|
| Alonso Campusano Lacoste | Product Owner | Ingesta por WhatsApp, IA con Gemini, modelo de datos e infraestructura |
| Pablo Vargas Soto | Scrum Master | Paneles web, app de terreno, tiempo real y protección de datos |

Ambos integrantes participan en las pruebas integrales, la documentación y la presentación final.

## Metodología

Scrum adaptado a un equipo de dos integrantes, con 7 sprints. La justificación, los roles y las ceremonias están en [Metodología](Fase%202/Evidencias%20Proyecto/Metodologia/Metodologia_MuniVox.docx).

| Sprint | Semanas | Foco |
|---|---|---|
| 1 | 1-2 | Levantamiento |
| 2 | 2-5 | Diseño y arquitectura |
| 3 | 5-8 | Infraestructura cloud |
| 4 | 9-11 | Ingesta e IA |
| 5 | 12-13 | Paneles |
| 6 | 14-16 | Pruebas y ajustes |
| 7 | 17-18 | Cierre y defensa |

## Modelo de datos

Diez entidades en PostgreSQL, definidas con Prisma: **Ciudadano**, **Reporte**, **Categoria**, **Departamento**, **Operador**, **Evidencia**, **HistorialEstado**, **SolicitudDatos**, **Auditoria** y **SuscripcionPush**.

Estados del reporte (`EstadoReporte`): `BOCETO` (borrador sin ubicación), `PENDIENTE`, `EN_REVISION`, `DESPACHADO`, `RESUELTO` y `DESCARTADO`. Todo cambio queda en el historial con operador, comentario y fecha. Plazos según prioridad: CRÍTICA 4 h, ALTA 24 h, MEDIA 72 h, BAJA 7 días.

Ver el [diccionario de datos](Fase%202/Evidencias%20Proyecto/Modelo%20de%20Datos/Diccionario_de_Datos_MuniVox.docx) y el [modelo entidad-relación](Fase%202/Evidencias%20Proyecto/Modelo%20de%20Datos/MuniVox_Modelo_Entidad_Relacion.png).

## Documentación del proyecto

| Documento | Ubicación |
|---|---|
| Metodología, Product Vision, Definition of Done, retrospectivas | `Fase 2/Evidencias Proyecto/Metodologia/` |
| Product Backlog y Sprint Backlog | `Fase 2/Evidencias Proyecto/Metodologia/` |
| Requisitos funcionales y no funcionales | `Fase 2/Evidencias Proyecto/Requisitos/` |
| Diagramas 4+1, arquitectura, casos de uso, componentes, estados, clases y secuencia | `Fase 2/Evidencias Proyecto/Diagramas/` |
| Modelo entidad-relación y diccionario de datos | `Fase 2/Evidencias Proyecto/Modelo de Datos/` |
| Plan y casos de prueba | `Fase 2/Evidencias Proyecto/Pruebas/` |
| Manual técnico y manual de usuario | `Fase 2/Evidencias Proyecto/Manual Tecnico/` |
| Innovación | `Fase 2/Evidencias Proyecto/Innovacion/` |
| Informes por fase y autoevaluaciones | `Fase 1/`, `Fase 2/` y `Fase 3/` |
