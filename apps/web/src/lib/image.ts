import { scaledSize } from "./driver-nav";

/** Shrink a phone photo (often 4000px+) before upload so it syncs quickly on poor coverage. */
export async function downscaleImage(file: Blob, max = 1600, quality = 0.8): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const { width, height } = scaledSize(bmp.width, bmp.height, max);
    const c = document.createElement("canvas");
    c.width = width; c.height = height;
    c.getContext("2d")!.drawImage(bmp, 0, 0, width, height);
    bmp.close();
    const out = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", quality));
    return out && out.size < file.size ? out : file;
  } catch {
    return file; // unsupported format: upload as is, the server validates the type
  }
}
