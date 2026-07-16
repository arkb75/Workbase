"use client";

import { LoaderCircle, Trash2 } from "lucide-react";
import { useFormStatus } from "react-dom";
import { deleteWorkItemAction } from "@/app/actions";

function DeleteButton({ title }: { title: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      aria-label={`Delete ${title}`}
      title={`Delete ${title}`}
      disabled={pending}
      onClick={(event) => {
        const confirmed = window.confirm(
          `Delete “${title}”?\n\nThis permanently removes its sources, evidence, highlights, Project Facts, chats, artifacts, and run history. This cannot be undone.`,
        );
        if (!confirmed) event.preventDefault();
      }}
      className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-full border border-black/10 bg-white/80 text-[color:var(--ink-muted)] shadow-sm transition hover:border-red-200 hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:cursor-wait disabled:opacity-60"
    >
      {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
    </button>
  );
}

export function DeleteWorkItemButton({ workItemId, title }: { workItemId: string; title: string }) {
  return (
    <form action={deleteWorkItemAction} className="relative z-20">
      <input type="hidden" name="workItemId" value={workItemId} />
      <DeleteButton title={title} />
    </form>
  );
}
