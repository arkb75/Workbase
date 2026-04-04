-- Remove the unused rejected status from VerificationStatus.
CREATE TYPE "VerificationStatus_new" AS ENUM ('draft', 'approved', 'flagged');

ALTER TABLE "Claim"
ALTER COLUMN "verificationStatus" TYPE "VerificationStatus_new"
USING ("verificationStatus"::text::"VerificationStatus_new");

ALTER TYPE "VerificationStatus" RENAME TO "VerificationStatus_old";
ALTER TYPE "VerificationStatus_new" RENAME TO "VerificationStatus";
DROP TYPE "VerificationStatus_old";
