import { handle } from "hono/vercel";
import { api } from "@/server/api/app";

// A tutor reply (plus the answer check) can take a while on hard problems.
export const maxDuration = 120;

const handler = handle(api);

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
