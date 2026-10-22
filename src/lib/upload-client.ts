/** Shrink a photo before upload: phone photos are often 4-12 MB, and 1600px is plenty for reading a worksheet. */
async function shrinkImage(file: File, maxSide = 1600, quality = 0.85): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file; // a format the browser can't decode; let the server decide
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? file), "image/jpeg", quality));
}

/** Upload a photo, screenshot or PDF; returns its id for attaching to a message. */
export async function uploadFile(file: File): Promise<number> {
  const isPdf = file.type === "application/pdf";
  if (!isPdf && !file.type.startsWith("image/")) throw new Error("Send a photo, screenshot or PDF");
  const body = isPdf ? file : await shrinkImage(file);
  const res = await fetch("/api/v1/uploads", {
    method: "POST",
    headers: { "content-type": isPdf ? "application/pdf" : body.type || "image/jpeg" },
    body,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "Upload failed");
  return (data as { id: number }).id;
}
