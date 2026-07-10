import { z } from "zod";

const githubObjectIdSchema = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i);

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

export const githubCommitResolutionSchema = z.object({
  sha: githubObjectIdSchema,
  html_url: z.string().url(),
  commit: z.object({
    tree: z.object({
      sha: githubObjectIdSchema,
      url: z.string().url(),
    }),
    committer: z
      .object({
        date: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  }),
});

export const githubGitTreeEntrySchema = z.object({
  path: z.string().min(1),
  mode: z.string(),
  type: z.enum(["blob", "tree", "commit"]),
  sha: githubObjectIdSchema,
  size: z.number().int().nonnegative().nullable().optional(),
  url: z.string().url(),
});

export const githubGitTreeSchema = z.object({
  sha: githubObjectIdSchema,
  url: z.string().url(),
  truncated: z.boolean(),
  tree: z.array(githubGitTreeEntrySchema),
});

export const githubCodeSearchSchema = z.object({
  total_count: z.number().int().nonnegative(),
  incomplete_results: z.boolean(),
  items: z.array(
    z.object({
      name: z.string().min(1),
      path: z.string().min(1),
      sha: z.string().min(1),
      html_url: z.string().url(),
      repository: z.object({
        id: z.union([z.string(), z.number()]).transform((value) => String(value)),
        full_name: z.string().min(1),
      }),
    }),
  ),
});

export const githubGitBlobSchema = z.object({
  sha: githubObjectIdSchema,
  size: z.number().int().nonnegative(),
  url: z.string().url(),
  content: z.string(),
  encoding: z.string().min(1),
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
