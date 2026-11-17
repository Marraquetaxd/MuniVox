-- ============================================================================
-- MuniVox v5: notificaciones push para funcionarios en terreno
-- Generado con "prisma migrate diff". Solo crea una tabla; no modifica datos.
-- Ejecutar UNA vez, ANTES de publicar la Lambda y el worker nuevos.
-- ============================================================================
BEGIN;

-- CreateTable
CREATE TABLE "SuscripcionPush" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "dispositivo" TEXT,
    "operadorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuscripcionPush_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SuscripcionPush_endpoint_key" ON "SuscripcionPush"("endpoint");

-- AddForeignKey
ALTER TABLE "SuscripcionPush" ADD CONSTRAINT "SuscripcionPush_operadorId_fkey" FOREIGN KEY ("operadorId") REFERENCES "Operador"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
