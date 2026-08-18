export const supportedUploadMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/tiff",
  "image/bmp",
  "image/gif",
  "application/pdf"
] as const;

export type SupportedUploadMimeType = (typeof supportedUploadMimeTypes)[number];

export function isSupportedUploadMimeType(value: string): value is SupportedUploadMimeType {
  return supportedUploadMimeTypes.includes(value as SupportedUploadMimeType);
}

export function normalizeSafeFilename(input: string): string {
  const normalized = input
    .normalize("NFKD")
    .replace(/[^\w.\- ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "")
    .toLowerCase();

  const withoutTraversal = normalized
    .split(/[\\/]+/)
    .filter((segment) => segment !== "." && segment !== ".." && segment.length > 0)
    .join("-");

  return withoutTraversal || "upload";
}

const crc32Table = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crc32Table[index] = value >>> 0;
}

export function crc32Hex(input: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc = crc32Table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

export function sanitizeCsvCell(input: string): string {
  return /^[=+\-@\t\r]/.test(input) ? `'${input}` : input;
}
