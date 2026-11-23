import { z } from "zod";

/**
 * JSON Schema d'une sortie structurée, au format accepté par Claude Code (`--json-schema`).
 * zod émet `"$schema": "https://json-schema.org/draft/2020-12/schema"`, que le validateur de
 * Claude Code ne connaît pas : on retire cette clé (le reste du schéma est compatible).
 */
export function toOutputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = json;
  return rest;
}
