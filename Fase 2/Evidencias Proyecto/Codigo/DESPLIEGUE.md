# Despliegue de MuniVox v3

Esta versión **sí cambia la base de datos**: agrega 2 columnas y 2 tablas. No borra ni modifica datos existentes.
Sigue el orden: si publicas la Lambda o el worker antes de ejecutar el SQL, fallarán al no encontrar las columnas nuevas.

## 1. Base de datos (primero)
Ejecuta una sola vez el archivo `munivox-db-cambios-v3.sql` (carpeta raíz del proyecto) en la base `postgres` de RDS, con tu cliente SQL habitual. Está dentro de `BEGIN/COMMIT`: si algo falla, no se aplica nada.

Qué agrega:
- `Reporte.tokenSeguimiento`: clave aleatoria para el enlace público de seguimiento.
- `Ciudadano.avisoPrivacidadEn`: fecha en que se le envió el aviso de privacidad.
- Tabla `SolicitudDatos`: solicitudes de los vecinos sobre sus datos (acceso, rectificación, supresión, oposición).
- Tabla `Auditoria`: bitácora de acciones sensibles del personal.

## 2. API Gateway (`nn4p1ybmu2`)
Así deben quedar las rutas. Todas usan la misma integración Lambda. Las marcadas **(nueva)** hay que crearlas:

```
Rutas para munivox-gateway

/auditoria                      (nueva)
- GET (JWT Auth)

/ciudadanos
- GET (JWT Auth)

/ciudadanos/{id}
- PUT (JWT Auth)

/operadores
- GET (JWT Auth)

/operadores/ubicacion
- PUT (JWT Auth)

/operadores/{id}
- PUT (JWT Auth)

/operadores/sincronizar
- POST (JWT Auth)

/publico/seguimiento            (nueva)
- GET (Sin Autenticación)
- POST (Sin Autenticación)

/solicitudes                    (nueva)
- GET (JWT Auth)
- POST (JWT Auth)

/solicitudes/{id}               (nueva)
- PUT (JWT Auth)

/tickets
- GET (JWT Auth)
- OPTIONS (Sin Autenticación)

/tickets/{id}
- PUT (JWT Auth)
- GET (JWT Auth)
```

`/publico/seguimiento` va **sin autenticación** a propósito: la usa el vecino desde su celular sin iniciar sesión. No entrega datos personales.
En la configuración CORS de API Gateway, revisa que `Access-Control-Allow-Methods` incluya `GET, POST, PUT, OPTIONS` (ya lo tiene).

## 3. Permisos de la Lambda en S3 (para la foto de cierre y la anonimización)
En IAM, al rol de ejecución de la Lambda agrégale este permiso (política en línea):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:DeleteObject"],
    "Resource": "arn:aws:s3:::munivox-evidencias-mvp/*"
  }]
}
```
Sin este permiso todo funciona, pero la foto de cierre no se guarda (el funcionario ve un aviso) y al anonimizar no se borran los archivos de S3. La Lambda debe usar Node.js 18 o superior.

## 4. Lambda
```powershell
cd munivox-lambda
npx prisma generate
Compress-Archive -Path index.js, package.json, node_modules, prisma -DestinationPath package.zip -Force
```
Sube el zip como siempre. Variable opcional nueva: `PANEL_URL` (por defecto, el dominio de Amplify).

## 5. worker-service
```powershell
cd worker-service
docker build -t munivoxacr2026.azurecr.io/worker-service:<vNN> .
az acr login --name munivoxacr2026
docker push munivoxacr2026.azurecr.io/worker-service:<vNN>
az containerapp update --name <app-worker> --resource-group <grupo> --image munivoxacr2026.azurecr.io/worker-service:<vNN>
```
Variables nuevas (opcionales):
- `PANEL_URL`: dominio público del dashboard (por defecto, el de Amplify). Se usa en los enlaces de seguimiento y de privacidad.
- `RETENCION_MESES`: activa la depuración automática diaria (4:00) de relatos y fotos de casos cerrados hace más de N meses. **Recomendado: 24.** Si cambias el número, cambia también `mesesConservacion` en `munivox-dashboard/lib/privacidad.ts`. Si no la defines, no se borra nada.
- `TOLERANCIA_LIMITE_M`: metros de tolerancia en el borde de la comuna (por defecto 150).

## 6. Dashboard
1. Completa los datos marcados `[COMPLETAR]` en `munivox-dashboard/lib/privacidad.ts` (dirección, correo para solicitudes, delegado de protección de datos y número de WhatsApp). Mientras no lo hagas, la página `/privacidad` los muestra destacados en amarillo.
2. Publica:
```powershell
cd munivox-dashboard
git add -A
git commit -m "MuniVox v3: seguimiento público, protección de datos y nuevas herramientas"
git push origin main
```

## 7. Comprobación
1. Escribe "hola" al WhatsApp desde un número nuevo: llega el aviso de privacidad y el menú con 3 botones.
2. Envía una ubicación fuera de Buin (por ejemplo, Santiago centro): debe responder que está fuera de la comuna.
3. Crea un reporte en Buin: la confirmación trae un enlace. Ábrelo en el celular y revisa que muestre el avance.
4. Escribe "estado": llega la lista de tus reportes para tocar uno.
5. En el C4, abre el reporte, toca **Escribir**, envía un mensaje y respóndelo desde WhatsApp: la respuesta aparece en el relato y en la campana de alertas.
6. Escribe "eliminar mis datos" y confirma: la solicitud aparece en Administración, pestaña Datos personales.
7. Cierra un caso desde `/terreno` con foto: el vecino recibe la foto y el informe.
