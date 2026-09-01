import { ArrowRight, ShieldCheck, Sparkles, Waypoints } from "lucide-react";
import { updateOnboardingAction } from "@/app/actions";
import { SubmitButton } from "@/components/forms/submit-button";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getDemoUser } from "@/src/lib/demo-user";
import { careerStageOptions, focusPreferenceOptions } from "@/src/lib/options";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const user = await getDemoUser();

  return (
    <div className="grid min-h-screen bg-[color:var(--bg)] lg:grid-cols-[1.1fr_0.9fr]">
      <section className="relative overflow-hidden bg-[color:var(--ink-strong)] px-8 py-12 text-white sm:px-12 lg:px-16 lg:py-16">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.28),transparent_38%),radial-gradient(circle_at_bottom_right,rgba(125,211,252,0.18),transparent_30%)]" />
        <div className="relative flex h-full flex-col justify-between">
          <div className="space-y-6">
            <p className="inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-1 text-xs uppercase tracking-[0.24em] text-white/75">
              <Sparkles className="h-3.5 w-3.5" />
              Workbase
            </p>
            <div className="space-y-4">
              <h1 className="max-w-xl font-display text-5xl font-semibold tracking-[-0.07em] sm:text-6xl">
                Verified evidence first. Career content second.
              </h1>
              <p className="max-w-lg text-base leading-7 text-white/72">
                Workbase turns projects and early experience into evidence-backed
                highlights that you can inspect, edit, and approve before they become
                a resume bullet or LinkedIn entry.
              </p>
            </div>
          </div>

          <div className="grid gap-6 sm:grid-cols-3">
            <div className="space-y-3">
              <ShieldCheck className="h-5 w-5 text-cyan-300" />
              <p className="text-sm font-medium">Authenticity stays visible</p>
              <p className="text-sm leading-6 text-white/65">
                Highlights always keep evidence, risks, and uncertainty attached.
              </p>
            </div>
            <div className="space-y-3">
              <Waypoints className="h-5 w-5 text-cyan-300" />
              <p className="text-sm font-medium">Target the right angle</p>
              <p className="text-sm leading-6 text-white/65">
                Reframe approved work for backend, full stack, data, or general recruiting.
              </p>
            </div>
            <div className="space-y-3">
              <ArrowRight className="h-5 w-5 text-cyan-300" />
              <p className="text-sm font-medium">Ship a usable loop fast</p>
              <p className="text-sm leading-6 text-white/65">
                This prototype starts with manual notes and a demo user, not a heavy integration stack.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="flex items-center px-6 py-10 sm:px-10 lg:px-14">
        <form action={updateOnboardingAction} className="w-full space-y-8">
          <div className="space-y-3">
            <p className="text-xs uppercase tracking-[0.22em] text-[color:var(--ink-muted)]">
              Onboarding
            </p>
            <h2 className="font-display text-4xl font-semibold tracking-[-0.06em] text-[color:var(--ink-strong)]">
              Calibrate the workspace.
            </h2>
            <p className="max-w-md text-base leading-7 text-[color:var(--ink-soft)]">
              Set your current context once. Workbase will keep the rest of the
              product language grounded in your actual goal.
            </p>
          </div>

          <div className="grid gap-6">
            <label className="grid gap-2">
              <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                Career stage
              </span>
              <Select name="careerStage" defaultValue={user.careerStage ?? "student"}>
                {careerStageOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                Current goal
              </span>
              <Textarea
                name="currentGoal"
                defaultValue={
                  user.currentGoal ??
                  "Turn my recent technical work into evidence-backed content I can use while applying."
                }
                placeholder="Describe what you are trying to prepare for."
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-[color:var(--ink-strong)]">
                Preferred focus
              </span>
              <Select
                name="focusPreference"
                defaultValue={user.focusPreference ?? "both"}
              >
                {focusPreferenceOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </label>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-[28px] border border-black/8 bg-[color:var(--surface)] px-5 py-4">
            <p className="max-w-sm text-sm leading-6 text-[color:var(--ink-soft)]">
              You can edit this later. The full prototype keeps one demo user and
              stores everything in the database.
            </p>
            <SubmitButton pendingLabel="Saving profile...">
              Enter Workbase
            </SubmitButton>
          </div>
        </form>
      </section>
    </div>
  );
}
