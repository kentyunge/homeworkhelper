@AGENTS.md

# Homework Helper

Study assistant for two kids (grades 7 and 9). See README.md for features and setup.

- It's a tutor, not an answer key. Any change to the tutor must keep the rules in `src/server/tutor/prompt.ts`: hint ladder, no final answers below rung 5, never writing for them.
- Replies are structured output (`src/lib/tutor-reply.ts`): `say` is spoken (no symbols), `show` is on-screen blocks. New visual = schema + prompt guidance + renderer in `src/components/tutor/`.
- Conversation history sent to Claude must stay append-only, and a session's system prompt is frozen at creation (`tutor_sessions.system_prompt`). Never edit stored turns or `turns.api`; add new turns instead.
- Every mutation goes through `src/server/*` services, exposed at `/api/v1` (`src/server/api/app.ts`). Client components call the API via `src/lib/api-client.ts`.
- Kids only see their own sessions (`canSeeSession` in `src/server/access.ts`); parents see everything.
- Schema changes: edit `src/db/schema.ts`, then `npm run db:generate`.
- Checks before committing: `npm run lint && npm run typecheck && npm test`.
