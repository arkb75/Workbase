import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/src/generated/prisma/client";

declare global {
  var prisma: PrismaClient | undefined;
}

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://demo:demo@127.0.0.1:5432/workbase";

const adapter = new PrismaPg({ connectionString });

export const prisma = globalThis.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalThis.prisma = prisma;
}
