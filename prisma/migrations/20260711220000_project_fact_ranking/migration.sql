ALTER TABLE "ProjectFact"
ADD COLUMN "productImportance" INTEGER,
ADD COLUMN "implementationBreadth" INTEGER,
ADD COLUMN "technicalDifficulty" INTEGER,
ADD COLUMN "distinctiveness" INTEGER;

ALTER TABLE "ProjectFact"
ADD CONSTRAINT "ProjectFact_productImportance_range" CHECK ("productImportance" IS NULL OR "productImportance" BETWEEN 0 AND 5),
ADD CONSTRAINT "ProjectFact_implementationBreadth_range" CHECK ("implementationBreadth" IS NULL OR "implementationBreadth" BETWEEN 0 AND 5),
ADD CONSTRAINT "ProjectFact_technicalDifficulty_range" CHECK ("technicalDifficulty" IS NULL OR "technicalDifficulty" BETWEEN 0 AND 5),
ADD CONSTRAINT "ProjectFact_distinctiveness_range" CHECK ("distinctiveness" IS NULL OR "distinctiveness" BETWEEN 0 AND 5);
