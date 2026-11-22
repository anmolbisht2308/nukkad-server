import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/* Photo storage. With GCS_BUCKET set (Cloud Run), files go to a public Cloud Storage bucket and
   the full https URL is stored. Without it (local dev), files go to ./uploads and are served by Express. */
const bucketName = process.env.GCS_BUCKET;

export async function savePublicFile(name: string, buf: Buffer, contentType: string): Promise<string> {
  if (bucketName) {
    const { Storage } = await import("@google-cloud/storage");
    const file = new Storage().bucket(bucketName).file(`uploads/${name}`);
    await file.save(buf, { contentType, resumable: false, metadata: { cacheControl: "public, max-age=604800" } });
    return `https://storage.googleapis.com/${bucketName}/uploads/${name}`;
  }
  await mkdir(path.resolve("uploads"), { recursive: true });
  await writeFile(path.resolve("uploads", name), buf);
  return `/uploads/${name}`;
}
