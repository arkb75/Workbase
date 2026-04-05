import { z } from "zod";

export const githubTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

export const githubViewerSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((value) => String(value)),
  login: z.string().min(1),
});

export const githubRepositorySummarySchema = z.object({
  id: z.union([z.string(), z.number()]).transform((value) => String(value)),
  name: z.string().min(1),
  full_name: z.string().min(1),
  description: z.string().nullable().optional(),
  html_url: z.string().url(),
  default_branch: z.string().min(1),
  private: z.boolean(),
  updated_at: z.string().nullable().optional(),
  owner: z.object({
    login: z.string().min(1),
  }),
});

export const githubRepositoryDetailSchema = githubRepositorySummarySchema.extend({
  topics: z.array(z.string()).optional(),
  language: z.string().nullable().optional(),
  homepage: z.string().nullable().optional(),
  visibility: z.string().nullable().optional(),
});

export const githubContentFileSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  html_url: z.string().url().nullable().optional(),
  content: z.string().optional(),
  encoding: z.string().optional(),
  type: z.string(),
});

export const githubCommitListItemSchema = z.object({
  sha: z.string().min(1),
  html_url: z.string().url().nullable().optional(),
  commit: z.object({
    message: z.string().min(1),
    author: z
      .object({
        name: z.string().nullable().optional(),
        date: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  }),
});

export const githubCommitDetailSchema = z.object({
  sha: z.string().min(1),
  files: z
    .array(
      z.object({
        filename: z.string().min(1),
      }),
    )
    .optional(),
});

export const githubPullRequestSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((value) => String(value)),
  number: z.number(),
  title: z.string().min(1),
  body: z.string().nullable().optional(),
  html_url: z.string().url(),
  state: z.string(),
  merged_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  user: z
    .object({
      login: z.string().min(1),
    })
    .nullable()
    .optional(),
});

export const githubPullRequestFileSchema = z.object({
  filename: z.string().min(1),
});

export const githubIssueSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((value) => String(value)),
  number: z.number(),
  title: z.string().min(1),
  body: z.string().nullable().optional(),
  html_url: z.string().url(),
  state: z.string(),
  updated_at: z.string().nullable().optional(),
  pull_request: z.unknown().optional(),
  user: z
    .object({
      login: z.string().min(1),
    })
    .nullable()
    .optional(),
});

export const githubReleaseSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((value) => String(value)),
  name: z.string().nullable().optional(),
  tag_name: z.string().min(1),
  body: z.string().nullable().optional(),
  html_url: z.string().url(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string().nullable().optional(),
});
