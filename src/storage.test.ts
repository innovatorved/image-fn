import { describe, expect, test } from "bun:test";
import { sanitizeBlobName } from "./storage";

describe("sanitizeBlobName", () => {
  test("keeps a plain blob name intact", () => {
    expect(sanitizeBlobName("1700000000-photo.webp")).toBe("1700000000-photo.webp");
  });

  test("collapses path traversal to the final segment", () => {
    expect(sanitizeBlobName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeBlobName("raw-images/../secret.webp")).toBe("secret.webp");
    expect(sanitizeBlobName("nested/dir/photo.png")).toBe("photo.png");
  });

  test("replaces characters Azure blob names should not carry", () => {
    expect(sanitizeBlobName("a b?c#d.png")).toBe("a_b_c_d.png");
    expect(sanitizeBlobName("photo%20name.jpg")).toBe("photo_20name.jpg");
  });

  test("handles empty and separator-only input without throwing", () => {
    expect(sanitizeBlobName("/")).toBe("");
    expect(sanitizeBlobName("..")).toBe("");
    expect(sanitizeBlobName("")).toBe("");
  });
});
