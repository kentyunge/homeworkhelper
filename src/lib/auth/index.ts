import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { emailOTP, magicLink, username } from "better-auth/plugins";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { sendEmail } from "@/lib/email";
import { APP_NAME } from "@/lib/app";

/** Parents sign in by email. Only these addresses can. */
export function parentEmails(): string[] {
  return (process.env.PARENT_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

const SIGN_IN_TTL = 60 * 15;

function signInEmail(link: string | null, code: string) {
  const color = "#4338ca";
  const button = link
    ? `<p style="margin:24px 0"><a href="${link}" style="background:${color};color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Sign in to ${APP_NAME}</a></p><p style="margin:0 0 8px">Or enter this code on the sign-in page:</p>`
    : `<p style="margin:0 0 8px">Enter this code on the sign-in page:</p>`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1e1b4b;max-width:480px">
<p style="margin:0 0 8px;font-size:18px;font-weight:700">${APP_NAME}</p>
${button}
<p style="margin:0 0 24px;font-size:32px;font-weight:700;letter-spacing:6px;font-family:ui-monospace,Menlo,Consolas,monospace">${code}</p>
<p style="margin:0;color:#64748b;font-size:13px">The link and code expire in 15 minutes. If you didn't ask to sign in, you can ignore this email.</p>
</div>`;
  const text = [
    `${APP_NAME} sign-in`,
    "",
    ...(link ? [`Sign in: ${link}`, "", "Or enter this code on the sign-in page:"] : ["Enter this code on the sign-in page:"]),
    code,
    "",
    "The link and code expire in 15 minutes.",
  ].join("\n");
  return { subject: `Your ${APP_NAME} sign-in code: ${code}`, html, text };
}

export const auth = betterAuth({
  appName: APP_NAME,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  // Kids sign in with username + PIN. Nobody can sign up: parents are listed in PARENT_EMAILS, and parents create kids.
  emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 4 },
  // Keep a kid signed in on their own device for a month.
  session: { expiresIn: 60 * 60 * 24 * 30 },
  user: {
    additionalFields: {
      role: { type: "string", required: false, defaultValue: "kid", input: false },
    },
  },
  plugins: [
    username(),
    magicLink({
      expiresIn: SIGN_IN_TTL,
      async sendMagicLink({ email, url }) {
        if (!parentEmails().includes(email.toLowerCase())) {
          console.warn(`[auth] sign-in link requested for non-parent email ${email}`);
          return;
        }
        // Email scanners open links to check them, which would use up a one-time link. The email links to
        // our own page instead, which signs in only when a person presses its button.
        const token = new URL(url).searchParams.get("token");
        if (!token) throw new Error("Magic link URL had no token");
        const link = new URL(`/login/verify?token=${encodeURIComponent(token)}`, url).toString();
        const code = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
        const { subject, html, text } = signInEmail(link, code);
        await sendEmail(email, subject, html, text);
      },
    }),
    emailOTP({
      otpLength: 6,
      expiresIn: SIGN_IN_TTL,
      allowedAttempts: 5,
      async sendVerificationOTP({ email, otp, type }) {
        if (type !== "sign-in" || !parentEmails().includes(email.toLowerCase())) return;
        const { subject, html, text } = signInEmail(null, otp);
        await sendEmail(email, subject, html, text);
      },
    }),
    nextCookies(),
  ],
  databaseHooks: {
    user: {
      create: {
        async before(user) {
          const email = user.email.toLowerCase();
          const role = parentEmails().includes(email) ? "parent" : "kid";
          return { data: { ...user, email, role, name: user.name || email.split("@")[0] } };
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
