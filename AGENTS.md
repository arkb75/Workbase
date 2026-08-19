<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Product implementation standard

Treat user-facing work as working product UI: establish a coherent hierarchy,
complete responsive and empty states, preserve accessible interaction, and
visually verify meaningful changes in a real browser.

Prefer direct implementations through existing data and service seams. Add an
abstraction only for repeated behavior or a current requirement. Use bounded
queries and deterministic transforms instead of speculative infrastructure,
while keeping module boundaries clear enough to extend when a real need appears.
