import { and, eq, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { uploads } from "@/db/schema";
import { badRequest, notFound } from "./errors";

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
export const UPLOAD_TYPES = [...IMAGE_TYPES, "application/pdf"];
/** Vercel rejects request bodies over 4.5 MB. The browser shrinks photos well below this before uploading. */
const MAX_IMAGE = 4 * 1024 * 1024;
const MAX_PDF = 4 * 1024 * 1024;
export const KEEP_DAYS = 30;

export async function saveUpload(kidId: number, mediaType: string, data: Buffer) {
  if (!UPLOAD_TYPES.includes(mediaType)) throw badRequest("Send a photo, screenshot or PDF");
  const max = mediaType === "application/pdf" ? MAX_PDF : MAX_IMAGE;
  if (data.length === 0) throw badRequest("That file is empty");
  if (data.length > max) throw badRequest(`That file is too big (max ${Math.round(max / 1024 / 1024)} MB)`);
  await purgeOldUploads();
  const [u] = await db.insert(uploads).values({ kidId, mediaType, bytes: data.length, data }).returning({ id: uploads.id });
  return { id: u.id, mediaType };
}

export async function getUpload(id: number) {
  const [u] = await db.select().from(uploads).where(eq(uploads.id, id));
  if (!u) throw notFound("That file has expired or doesn't exist");
  return u;
}

export async function loadUploads(ids: number[]) {
  if (ids.length === 0) return new Map<number, typeof uploads.$inferSelect>();
  const rows = await db.select().from(uploads).where(inArray(uploads.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Uploads must belong to the kid sending them. */
export async function assertKidOwnsUploads(kidId: number, ids: number[]) {
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: uploads.id })
    .from(uploads)
    .where(and(eq(uploads.kidId, kidId), inArray(uploads.id, ids)));
  if (rows.length !== new Set(ids).size) throw badRequest("One of those files couldn't be found. Try adding it again.");
}

/** Photos of schoolwork aren't kept forever. Runs on each upload, so no scheduled job is needed. */
export async function purgeOldUploads(now = new Date()) {
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000);
  await db.delete(uploads).where(lt(uploads.createdAt, cutoff));
}
