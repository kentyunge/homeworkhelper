# Homework Helper

A voice-first study assistant for the kids. It guides their thinking with hints, worked examples, and visuals, and doesn't hand over answers. Version 1 focuses on math.

## What it does

- **Kids** sign in with a username and PIN on their own device (Chromebook, Mac, iPhone). They snap a photo of a worksheet, upload a screenshot or PDF, type, or hold the mic and talk.
- **The tutor** confirms it read the problem right, asks what they've tried, then climbs the **hint ladder** one rung at a time:
  1. Clarify the question
  2. Name the concept
  3. Show the first step
  4. Work a *similar* problem (different numbers)
  5. Walk through their actual problem (off by default)
- **Talk and show.** Each reply has a short spoken line (`say`) and on-screen content (`show`): typeset math, tap-to-reveal steps, practice problems that check answers, number lines, fraction bars, graphs, and a line-by-line review of their work that highlights the first step that went wrong.
- **Double-check replies (optional).** A second, cheaper model reads each draft and sends it back if it gives away the answer.
- **Flag for a parent.** Kids save a conversation to go over together. Flags show on the kid's home screen and the parent page.
- **Parents** set, per kid: grade, the highest hint rung, the assistant's name and personality (witty butler, encouraging coach, playful sidekick, plus notes), and voice.
- **Writing:** brainstorming bullets, questions, and high-level feedback only. It never writes sentences for them.
- Photos are deleted after 30 days.

## Stack

Same setup as Woodside Wednesday.

| Layer | Choice |
|---|---|
| App | Next.js 16 (App Router, React 19), Tailwind v4, shadcn/ui |
| API | Hono at `/api/v1` (`src/server/api/app.ts`) |
| Database | Postgres via Drizzle: **Neon** in production, embedded **PGlite** locally |
| Auth | Better Auth: parents by email link/code, kids by username + PIN |
| AI | Claude API: `claude-opus-5-5` tutor, `claude-haiku-5-5` answer check |
| Voice | Browser speech recognition + browser voices (free); ElevenLabs optional |
| Hosting | Vercel Hobby (free) |

## Costs

- Vercel, Neon, and Resend free tiers: $0.
- Claude: roughly **$30–40/month** for two kids on Opus 5.5, about half that with `TUTOR_MODEL=claude-sonnet-5-5`. The parent page shows an estimate for the month to date. **Set a monthly spend limit** in the Anthropic Console.
- ElevenLabs (optional): roughly $10–25/month for natural voices.

## Local development

```bash
npm install
cp .env.example .env.local   # set BETTER_AUTH_SECRET and PARENT_EMAILS
npm run db:migrate           # creates ./.pglite
npm run dev
```

Open http://localhost:3000, choose **Parent**, and enter your email. The sign-in code prints in the terminal. Add a kid, then sign in as them in another browser.

Without `ANTHROPIC_API_KEY` the tutor runs in **demo mode**: canned replies that show off each visual tool.

| Script | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm test` | Service tests (in-memory Postgres, fake Claude) |
| `npm run typecheck` / `npm run lint` | Types / ESLint |
| `npm run db:generate` | New migration after editing `src/db/schema.ts` |

## Deploying to Vercel

1. Create a Neon database (free) and copy the **pooled** connection string.
2. Import this repo in Vercel. Set the environment variables from `.env.example`: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (your Vercel URL), `PARENT_EMAILS`, `ANTHROPIC_API_KEY`, and optionally `RESEND_API_KEY`/`EMAIL_FROM` and the ElevenLabs keys.
3. Deploy. The `vercel-build` script runs migrations first.

## Voice

- **Listening** uses the browser's speech recognition. Hold the mic button (or the space bar) to talk; release to send. In Chrome, audio is sent to Google for transcription. School-managed Chromebooks may block the microphone, so typing always works too.
- **Speaking** uses the browser's built-in voices by default. For natural voices, set `ELEVENLABS_API_KEY`, then on a kid's settings page choose **Natural voice** and paste a voice ID from the ElevenLabs library. Use **Hear it** to audition. If ElevenLabs fails, it falls back to the browser voice.
- To add another voice service, add a function like `src/server/tts.ts` and a provider option in `src/server/family.ts`.

## How the tutor works (for future changes)

- `src/server/tutor/prompt.ts`: the tutor's rules (hint ladder, personality, writing, staying on topic).
- `src/lib/tutor-reply.ts`: the reply schema (`say` + `show` blocks) used for structured output and rendering.
- `src/server/tutor/index.ts`: sessions and turns. The system prompt is **frozen per session** and history is **append-only**. Claude checks that earlier context hasn't changed between turns, so don't edit stored turns or the stored system prompt. Settings changes apply to new sessions.
- `src/server/tutor/engine.ts`: the Claude calls (tutor + answer check). `demo.ts` is the canned demo.
- `src/components/tutor/`: renderers for each visual block. To add a new visual, add it to the schema, describe when to use it in the prompt, and add a renderer.
