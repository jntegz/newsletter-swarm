/**
 * Virus-scan hook for uploads. The interface is fixed now so a scanner can be plugged in later
 * without touching the upload route; until then every file that passed type sniffing is accepted.
 */
interface ScanVerdict {
  clean: boolean;
  /** The scanner's reason, for logs only. Never shown to the uploader. */
  reason?: string;
}

type UploadScanner = (bytes: Uint8Array, contentType: string) => Promise<ScanVerdict>;

let scanner: UploadScanner = async () => ({ clean: true });

export function scanUpload(bytes: Uint8Array, contentType: string): Promise<ScanVerdict> {
  return scanner(bytes, contentType);
}

/** Replaces the scanner. Used by tests, and by a real implementation when one exists. */
export function setUploadScanner(next: UploadScanner): void {
  scanner = next;
}
