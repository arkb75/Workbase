import { prisma } from "@/src/lib/prisma";
import { DEMO_USER_EMAIL, DEMO_USER_NAME } from "@/src/lib/options";

export async function ensureDemoUser() {
  return prisma.user.upsert({
    where: {
      email: DEMO_USER_EMAIL,
    },
    update: {
      name: DEMO_USER_NAME,
    },
    create: {
      email: DEMO_USER_EMAIL,
      name: DEMO_USER_NAME,
    },
  });
}

export async function getDemoUser() {
  const demoUser = await ensureDemoUser();
  return prisma.user.findUniqueOrThrow({
    where: {
      id: demoUser.id,
    },
  });
}
