-- ============================================================================
-- MuniVox v4: turno del funcionario separado del GPS
-- Generado con "prisma migrate diff". Solo agrega una columna; no modifica datos.
-- Ejecutar UNA vez, ANTES de publicar la Lambda y el worker nuevos.
-- ============================================================================
BEGIN;

-- AlterTable
ALTER TABLE "Operador" ADD COLUMN "enTurno" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
