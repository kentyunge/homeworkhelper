import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const from = process.env.EMAIL_FROM ?? "Homework Helper <onboarding@resend.dev>";

export async function sendEmail(to: string, subject: string, html: string, text: string) {
  if (!resend) {
    // Local development: no email provider configured, so print the message.
    console.log(`\n[email] to=${to} subject="${subject}"\n${text}\n`);
    return;
  }
  const { error } = await resend.emails.send({ from, to, subject, html, text });
  if (error) throw new Error(`Email failed: ${error.message}`);
}
