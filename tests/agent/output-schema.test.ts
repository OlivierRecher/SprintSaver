import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toOutputJsonSchema } from "../../src/agent/output-schema.js";
import { AnalyseOutput } from "../../src/phases/schemas.js";

describe("toOutputJsonSchema", () => {
  it("retire $schema et garde la structure", () => {
    const s = toOutputJsonSchema(z.object({ files: z.array(z.string()) }));
    expect(s).not.toHaveProperty("$schema");
    expect(s).toMatchObject({ type: "object", properties: { files: { type: "array" } }, required: ["files"] });
  });
  it("aucun $schema imbriqué dans les schémas de phase", () => {
    expect(JSON.stringify(toOutputJsonSchema(AnalyseOutput))).not.toContain("$schema");
  });
});
