import { describe, expect, it } from "vitest";
import {
  generatedPrismaSchemaSignature,
  prismaClientRuntimeSchemaSignature,
} from "@/src/lib/prisma-runtime-schema";

describe("Prisma runtime schema signatures", () => {
  it("matches generated scalar enums to the loaded runtime model regardless of field order", () => {
    const generated = generatedPrismaSchemaSignature({
      ProjectFactScalarFieldEnum: { id: "id", productImportance: "productImportance" },
      WorkItemScalarFieldEnum: { title: "title", id: "id" },
    });
    const runtime = prismaClientRuntimeSchemaSignature({
      _runtimeDataModel: {
        models: {
          WorkItem: { fields: [{ name: "id", kind: "scalar" }, { name: "title", kind: "scalar" }] },
          ProjectFact: {
            fields: [
              { name: "productImportance", kind: "scalar" },
              { name: "workItem", kind: "object" },
              { name: "id", kind: "scalar" },
            ],
          },
        },
      },
    });

    expect(runtime).toBe(generated);
  });

  it("detects a stale runtime model missing a newly generated field", () => {
    const generated = generatedPrismaSchemaSignature({
      ProjectFactScalarFieldEnum: { id: "id", productImportance: "productImportance" },
    });
    const stale = prismaClientRuntimeSchemaSignature({
      _runtimeDataModel: { models: { ProjectFact: { fields: [{ name: "id", kind: "scalar" }] } } },
    });

    expect(stale).not.toBe(generated);
  });
});
