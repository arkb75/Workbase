import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/src/generated/prisma/client";
import {
  generatedPrismaSchemaSignature,
  prismaClientRuntimeSchemaSignature,
} from "@/src/lib/prisma-runtime-schema";

declare global {
  var prisma: PrismaClient | undefined;
}

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://demo:demo@127.0.0.1:5432/workbase";

const adapter = new PrismaPg({ connectionString });

const generatedSchemaSignature = generatedPrismaSchemaSignature(Prisma as unknown as Record<string, unknown>);
const existingSchemaSignature = globalThis.prisma
  ? prismaClientRuntimeSchemaSignature(globalThis.prisma)
  : null;
const canReuseDevelopmentClient = Boolean(
  globalThis.prisma &&
  generatedSchemaSignature &&
  existingSchemaSignature === generatedSchemaSignature,
);

// Next.js intentionally preserves this singleton across hot reloads. Replace it
// when `prisma generate` changes the runtime data model, otherwise new service
// code can execute against an old in-memory Prisma contract until restart.
if (globalThis.prisma && !canReuseDevelopmentClient) {
  void globalThis.prisma.$disconnect();
}

export const prisma = canReuseDevelopmentClient
  ? globalThis.prisma!
  : new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalThis.prisma = prisma;
}
