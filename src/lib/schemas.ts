import { z } from "zod";

const careerStageValues = [
  "student",
  "intern",
  "new_grad",
  "early_career_engineer",
] as const;
const focusPreferenceValues = ["projects", "work_experience", "both"] as const;
const workItemTypeValues = ["project", "experience"] as const;
const visibilityValues = [
  "private",
  "resume_safe",
  "linkedin_safe",
  "public_safe",
] as const;
const artifactTypeValues = [
  "resume_bullets",
  "linkedin_experience",
  "project_summary",
] as const;
const targetAngleValues = [
  "general",
  "ai_ml",
  "data_engineering",
  "backend",
  "full_stack",
] as const;
const artifactToneValues = [
  "concise",
  "technical",
  "recruiter_friendly",
] as const;

export const onboardingSchema = z.object({
  careerStage: z.enum(careerStageValues),
  currentGoal: z.string().trim().min(12).max(240),
  focusPreference: z.enum(focusPreferenceValues),
});

export const workItemSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    type: z.enum(workItemTypeValues),
    description: z.string().trim().min(16).max(600),
    startDate: z.string().optional().or(z.literal("")),
    endDate: z.string().optional().or(z.literal("")),
  })
  .refine(
    (value) =>
      !value.startDate ||
      !value.endDate ||
      new Date(value.startDate) <= new Date(value.endDate),
    {
      message: "End date must be after the start date.",
      path: ["endDate"],
    },
  );

export const manualSourceSchema = z.object({
  workItemId: z.string().trim().min(1),
  label: z.string().trim().min(2).max(80),
  rawContent: z.string().trim().min(20).max(3000),
});

export const githubSourceSchema = z.object({
  workItemId: z.string().trim().min(1),
  label: z.string().trim().min(2).max(80),
  repoUrl: z.string().trim().url().max(300),
});

export const claimUpdateSchema = z.object({
  workItemId: z.string().trim().min(1),
  text: z.string().trim().min(10).max(240),
  visibility: z.enum(visibilityValues),
  sensitivityFlag: z.boolean(),
  verificationNotes: z.string().trim().max(1200).optional(),
  intent: z.enum(["save", "approve", "reject"]),
});

export const artifactGenerationSchema = z.object({
  workItemId: z.string().trim().min(1),
  type: z.enum(artifactTypeValues),
  targetAngle: z.enum(targetAngleValues),
  tone: z.enum(artifactToneValues),
});

export function formDataToBoolean(value: FormDataEntryValue | null) {
  return value === "on" || value === "true";
}
