import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  it("responds 200 with an ok status and a timestamp", async () => {
    const response = await GET();

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toMatchObject({ status: "ok" });
    expect(typeof body.timestamp).toBe("string");
    // Round-trips through Date without throwing — catches a regression where
    // `timestamp` stops being a valid ISO string.
    expect(Number.isNaN(new Date(body.timestamp).getTime())).toBe(false);
  });
});
