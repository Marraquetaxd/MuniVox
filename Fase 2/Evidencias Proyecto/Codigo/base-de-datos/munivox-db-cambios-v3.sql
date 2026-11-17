-- ============================================================================
-- MuniVox v3: cambios en la base de datos (PostgreSQL, esquema public)
-- Generado con "prisma migrate diff" a partir de schema.prisma.
-- Solo AGREGA columnas y tablas: no borra ni modifica datos existentes.
-- Ejecutar UNA vez, ANTES de publicar la Lambda y el worker nuevos.
-- ============================================================================
BEGIN;

-- AlterTable
ALTER TABLE "Ciudadano" ADD COLUMN     "avisoPrivacidadEn" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Reporte" ADD COLUMN     "tokenSeguimiento" TEXT;

-- CreateTable
CREATE TABLE "SolicitudDatos" (
    "id" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'PENDIENTE',
    "canal" TEXT NOT NULL DEFAULT 'WHATSAPP',
    "detalle" TEXT,
    "respuesta" TEXT,
    "ciudadanoId" TEXT NOT NULL,
    "operadorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resueltaEn" TIMESTAMP(3),

    CONSTRAINT "SolicitudDatos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Auditoria" (
    "id" TEXT NOT NULL,
    "accion" TEXT NOT NULL,
    "entidad" TEXT NOT NULL,
    "entidadId" TEXT,
    "detalle" TEXT,
    "operadorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Auditoria_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SolicitudDatos_estado_createdAt_idx" ON "SolicitudDatos"("estado", "createdAt");

-- CreateIndex
CREATE INDEX "Auditoria_createdAt_idx" ON "Auditoria"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Reporte_tokenSeguimiento_key" ON "Reporte"("tokenSeguimiento");

-- AddForeignKey
ALTER TABLE "SolicitudDatos" ADD CONSTRAINT "SolicitudDatos_ciudadanoId_fkey" FOREIGN KEY ("ciudadanoId") REFERENCES "Ciudadano"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolicitudDatos" ADD CONSTRAINT "SolicitudDatos_operadorId_fkey" FOREIGN KEY ("operadorId") REFERENCES "Operador"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Auditoria" ADD CONSTRAINT "Auditoria_operadorId_fkey" FOREIGN KEY ("operadorId") REFERENCES "Operador"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
