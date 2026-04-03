import { redirect } from "next/navigation";
import { getDemoUser } from "@/src/lib/demo-user";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await getDemoUser();

  if (!user.careerStage || !user.currentGoal || !user.focusPreference) {
    redirect("/onboarding");
  }

  redirect("/dashboard");
}
