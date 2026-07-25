import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationPath =
  "prisma/migrations/20260725220000_versioned_embedding_indexes/migration.sql";
const safetyMigrationPath =
  "prisma/migrations/20260725221000_validate_versioned_embedding_space/migration.sql";

describe("versioned embedding migration", () => {
  it("rejects a mixed or non-Titan legacy vector space before assignment", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toContain("identity_count > 1");
    expect(migration).toContain(
      `"modelId" <> 'amazon.titan-embed-text-v2:0'`,
    );
    expect(migration).toContain('"dimensions" <> 512');
    expect(migration.indexOf("identity_count > 1")).toBeLessThan(
      migration.indexOf('UPDATE "HighlightEmbedding" SET "indexVersionId"'),
    );
  });

  it("drops every mixed-space global HNSW graph in both migration paths", () => {
    for (const path of [migrationPath, safetyMigrationPath]) {
      const migration = readFileSync(path, "utf8");
      for (const index of [
        "HighlightEmbedding_embedding_hnsw_idx",
        "ProjectFactEmbedding_embedding_hnsw_idx",
        "EvidenceEmbedding_embedding_hnsw_idx",
        "ArtifactEmbedding_embedding_hnsw_idx",
      ]) {
        expect(migration).toContain(`DROP INDEX IF EXISTS "${index}"`);
      }
    }
  });

  it("scopes the compatibility validation to legacy rows when candidates already exist", () => {
    const migration = readFileSync(safetyMigrationPath, "utf8");
    expect(
      migration.match(
        /WHERE "indexVersionId" = 'legacy-bedrock-titan-v2-512'/g,
      ),
    ).toHaveLength(8);
  });
});
