export function formatTaggedSections(
  sections: Array<{
    tag: string;
    content: string;
  }>,
) {
  return sections
    .map(
      (section) => `<${section.tag}>\n${section.content.trim()}\n</${section.tag}>`,
    )
    .join("\n\n");
}
