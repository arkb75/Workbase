import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const adapter = new PrismaPg({
  connectionString:
    process.env.DATABASE_URL ?? "postgresql://demo:demo@127.0.0.1:5432/workbase",
});
const prisma = new PrismaClient({ adapter });

async function main() {
  const demoUser = await prisma.user.upsert({
    where: {
      email: process.env.WORKBASE_DEMO_USER_EMAIL ?? "demo@workbase.app",
    },
    update: {
      name: process.env.WORKBASE_DEMO_USER_NAME ?? "Workbase Demo User",
      careerStage: "new_grad",
      currentGoal: "Turn recent projects into credible, recruiter-ready experience.",
      focusPreference: "both",
    },
    create: {
      email: process.env.WORKBASE_DEMO_USER_EMAIL ?? "demo@workbase.app",
      name: process.env.WORKBASE_DEMO_USER_NAME ?? "Workbase Demo User",
      careerStage: "new_grad",
      currentGoal: "Turn recent projects into credible, recruiter-ready experience.",
      focusPreference: "both",
    },
  });

  const workItem = await prisma.workItem.upsert({
    where: {
      id: "sample-work-item",
    },
    update: {
      title: "Campus research search platform",
      type: "project",
      description:
        "Built a full-stack search tool that helps lab members find experiment metadata and annotate results.",
    },
    create: {
      id: "sample-work-item",
      userId: demoUser.id,
      title: "Campus research search platform",
      type: "project",
      description:
        "Built a full-stack search tool that helps lab members find experiment metadata and annotate results.",
      startDate: new Date("2025-01-15"),
      endDate: new Date("2025-03-28"),
    },
  });

  await prisma.source.upsert({
    where: {
      id: "sample-note-source",
    },
    update: {
      rawContent: `Built a Next.js dashboard for lab members to search experiment records.
Integrated Prisma with PostgreSQL and added role-aware filters for internal and public datasets.
Created background import scripts to normalize CSV uploads from multiple teams.
Worked with two classmates and the lab coordinator to tighten wording for sensitive data.`,
    },
    create: {
      id: "sample-note-source",
      workItemId: workItem.id,
      type: "manual_note",
      label: "Interview prep notes",
      rawContent: `Built a Next.js dashboard for lab members to search experiment records.
Integrated Prisma with PostgreSQL and added role-aware filters for internal and public datasets.
Created background import scripts to normalize CSV uploads from multiple teams.
Worked with two classmates and the lab coordinator to tighten wording for sensitive data.`,
    },
  });

  await prisma.source.upsert({
    where: {
      id: "sample-github-source",
    },
    update: {
      metadata: {
        repoUrl: "https://github.com/workbase/sample-research-search",
        status: "placeholder",
      },
    },
    create: {
      id: "sample-github-source",
      workItemId: workItem.id,
      type: "github_repo",
      label: "GitHub repo placeholder",
      metadata: {
        repoUrl: "https://github.com/workbase/sample-research-search",
        status: "placeholder",
      },
    },
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
