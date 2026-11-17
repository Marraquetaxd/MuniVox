# Simulador de funcionarios en terreno

Solo para demostraciones. Crea 6 funcionarios de Aseo y Ornato de prueba (correo `@munivox.demo`) y los mueve por calles reales de Buin:

- 4 recorren la comuna en camioneta (rutas de Mapbox) y se detienen entre 25 y 90 segundos a "trabajar" al llegar.
- 2 se quedan quietos en un punto, con pequeñas variaciones como las de un GPS real.

Cada 3 segundos escribe las posiciones en PostgreSQL y publica `operadores-cambio` en Redis. El `socket-service` lo retransmite y los paneles (Equipos en terreno y `/departamentos`) recargan el personal al instante. En el mapa los marcadores se deslizan entre posiciones.

También puede **estacionar una cuenta real** (el celular de la demo) en Buin. Cuando ese funcionario toca **Voy en camino**, el simulador lo lleva por la calle hasta el reporte.

## Requisitos

- `npm install` dentro de esta carpeta (una vez).
- `DATABASE_URL`: se toma de `../munivox-lambda/.env` si no está en `simulador/.env`.
- Token de Mapbox: se toma de `../munivox-dashboard/.env.local`.
- `REDIS_HOST` en `simulador/.env`: el mismo host de Redis del `worker-service` (balanceador NLB). Sin él funciona igual, pero los paneles solo se actualizan con su refresco automático (20 a 60 s).
- El `socket-service` desplegado con el canal `operadores-cambio` (versión de esta carpeta).

## Comandos

```
node simulador.js alta        crea o reactiva los 6 funcionarios simulados
node simulador.js iniciar     los mueve hasta presionar Ctrl+C
node simulador.js estado      muestra turno, GPS y posición de cada uno
node simulador.js limpiar     los borra (los casos que tuvieran asignados quedan sin asignar)
node simulador.js rutas       prueba las rutas de Mapbox sin tocar la base
```

Opciones de `iniciar`:

| Opción | Uso |
|---|---|
| `--estacionar <correo>` | Cuenta real de terreno que se muestra en Buin y viaja al reporte al tocar "Voy en camino" |
| `--reporte <MUN-123456>` | Estaciona esa cuenta a unos 400 m del reporte (si no, en el centro de Buin) |
| `--velocidad <km/h>` | Velocidad de los vehículos (por defecto 30; para la demo, 40 a 50 se ve mejor) |
| `--cada <segundos>` | Frecuencia de actualización (por defecto 3) |

Con `SIMULADOR_SECO=1` no se toca la base: las posiciones se muestran en la consola.

Al detener con Ctrl+C, los funcionarios simulados terminan el turno y se borran sus posiciones; la cuenta estacionada deja de mostrarse en el mapa.

## Guion de la demo

1. Antes de empezar:
   - Enviar un reporte de prueba por WhatsApp y derivarlo a Aseo y Ornato desde el C4 (anotar su código `MUN-`).
   - En el celular: iniciar sesión con la cuenta de terreno de Aseo, activar **En turno** y **Notificaciones**, dejar **Compartir ubicación apagado** y la app abierta en "Por aceptar".
   - En el PC:
     ```
     node simulador.js alta
     node simulador.js iniciar --estacionar <correo-del-celular> --reporte MUN-123456 --velocidad 45
     ```
2. Mostrar en el C4 la vista **Equipos en terreno**: funcionarios moviéndose por las calles y otros detenidos.
3. Abrir `/departamentos` (desde el C4 en modo supervisión, eligiendo Aseo y Ornato), abrir el reporte y asignarlo a la cuenta del celular. Al pasar el cursor sobre cada funcionario se dibuja la línea hasta el reporte.
4. En el celular llega la notificación (y vibra con la app abierta). Tocar **Tomar caso**, luego **Voy en camino**: en el mapa del panel el funcionario empieza a moverse hacia el reporte.
5. Al llegar, **Resolver** con informe y foto. El vecino recibe el aviso por WhatsApp.
6. Terminar con Ctrl+C y, si no se volverá a usar, `node simulador.js limpiar`.

Los funcionarios simulados no aceptan tareas: no asignarles el reporte de la demo.
