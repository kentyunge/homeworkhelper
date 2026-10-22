import { describe, expect, it } from "vitest";
import { sameAnswer } from "./answers";

describe("sameAnswer", () => {
  it("matches equivalent forms", () => {
    expect(sameAnswer("5", "5")).toBe(true);
    expect(sameAnswer("x = 5", "5")).toBe(true);
    expect(sameAnswer("0.5", "1/2")).toBe(true);
    expect(sameAnswer("−3/4", "-0.75")).toBe(true);
    expect(sameAnswer(" X=-2 ", "x = -2")).toBe(true);
  });
  it("rejects wrong or empty answers", () => {
    expect(sameAnswer("4", "5")).toBe(false);
    expect(sameAnswer("", "5")).toBe(false);
    expect(sameAnswer("1/3", "0.33")).toBe(false);
  });
  it("compares non-numeric answers as text", () => {
    expect(sameAnswer("x > 3", "x>3")).toBe(true);
    expect(sameAnswer("x < 3", "x>3")).toBe(false);
  });
});
