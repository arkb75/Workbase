import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: Date | string | null | undefined) {
  if (!date) {
    return "Not set";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
  }).format(new Date(date));
}

export function formatDateRange(
  startDate: Date | string | null | undefined,
  endDate: Date | string | null | undefined,
) {
  if (!startDate && !endDate) {
    return "Date range not provided";
  }

  if (startDate && !endDate) {
    return `${formatDate(startDate)} to Present`;
  }

  return `${formatDate(startDate)} to ${formatDate(endDate)}`;
}

export function titleCase(value: string) {
  return value
    .split("_")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function toSentence(value: string) {
  const normalized = normalizeWhitespace(value)
    .replace(/^[-*]\s*/, "")
    .replace(/\.$/, "");

  if (!normalized) {
    return normalized;
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function slugifyText(value: string) {
  return normalizeWhitespace(value).toLowerCase();
}
