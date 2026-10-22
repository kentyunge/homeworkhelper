import { describe, expect, it } from "vitest";
import { appOrigins } from ".";

describe("appOrigins", () => {
  it("trusts BETTER_AUTH_URL and every Vercel address, without trailing slashes or duplicates", () => {
    expect(
      appOrigins({
        BETTER_AUTH_URL: "https://homeworkhelper.vercel.app/",
        VERCEL_PROJECT_PRODUCTION_URL: "homeworkhelper.vercel.app",
        VERCEL_BRANCH_URL: "homeworkhelper-git-main-kent.vercel.app",
        VERCEL_URL: "homeworkhelper-abc123-kent.vercel.app",
        TRUSTED_ORIGINS: "https://study.example.com/, ",
      }),
    ).toEqual([
      "https://homeworkhelper.vercel.app",
      "https://homeworkhelper-git-main-kent.vercel.app",
      "https://homeworkhelper-abc123-kent.vercel.app",
      "https://study.example.com",
    ]);
  });

  it("falls back to the production Vercel address when BETTER_AUTH_URL isn't set", () => {
    expect(appOrigins({ VERCEL_PROJECT_PRODUCTION_URL: "homeworkhelper.vercel.app" })[0]).toBe("https://homeworkhelper.vercel.app");
  });
});
