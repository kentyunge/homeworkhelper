import { describe, expect, it } from "vitest";
import { compareLines, isSolutionLine, latexToMath } from "./math-check";

describe("latexToMath", () => {
  it("handles the LaTeX the reader produces", () => {
    expect(latexToMath("3x-12=2x+5")).toBe("3x-12=2x+5");
    expect(latexToMath("\\frac{1}{2}x = 4")).toBe("((1)/(2))x = 4");
    expect(latexToMath("2xy")).toBe("2x*y");
    expect(latexToMath("x(x+1)")).toBe("x*(x+1)");
    expect(latexToMath("x^{2} − 9")).toBe("x^(2) - 9");
    expect(latexToMath("\\sqrt{x+1}")).toBe("sqrt(x+1)");
    expect(latexToMath("6 \\div 3 \\cdot 2")).toBe("6 / 3 * 2");
    expect(latexToMath("\\left(x+1\\right)^2")).toBe("(x+1)^2");
  });
  it("gives up on things it shouldn't judge", () => {
    expect(latexToMath("x < 5")).toBeNull();
    expect(latexToMath("x \\geq 2")).toBeNull();
    expect(latexToMath("\\text{area} = 12")).toBeNull();
    expect(latexToMath("")).toBeNull();
  });
});

describe("compareLines: equations", () => {
  it("accepts correct steps", () => {
    expect(compareLines("3(x-4)=2x+5", "3x-12=2x+5")).toBe("same"); // distribute
    expect(compareLines("3x-12=2x+5", "x-12=5")).toBe("same"); // subtract 2x
    expect(compareLines("x-12=5", "x=17")).toBe("same");
    expect(compareLines("2x+6=10", "x+3=5")).toBe("same"); // divide both sides
    expect(compareLines("\\frac{x}{3}=4", "x=12")).toBe("same");
    expect(compareLines("4=x-1", "x=5")).toBe("same"); // sides swapped
    expect(compareLines("0.5x = 2", "x = 4")).toBe("same");
    expect(compareLines("2(x+y)=10", "x+y=5")).toBe("same"); // two variables
    expect(compareLines("x^2+5x+6=0", "(x+2)(x+3)=0")).toBe("same"); // factoring
  });

  it("catches common mistakes", () => {
    expect(compareLines("x-12=5", "x=-7")).toBe("different"); // sign error
    expect(compareLines("3(x-4)=2x+5", "3x-4=2x+5")).toBe("different"); // didn't distribute to both
    expect(compareLines("2x=10", "x=20")).toBe("different"); // multiplied instead of divided
    expect(compareLines("-3x = 9", "x = 3")).toBe("different"); // dropped the negative
  });

  it("leaves rounding, nonlinear steps and odd cases to the tutor", () => {
    expect(compareLines("3x=1", "x=0.33")).toBe("unknown"); // rounding
    expect(compareLines("x^2=9", "x=3")).toBe("unknown"); // lost a solution: tutor explains
    expect(compareLines("x < 4", "x < 2")).toBe("unknown");
    expect(compareLines("2x+3", "x=4")).toBe("unknown"); // expression then equation
    expect(compareLines("Sam has 3 apples", "x=3")).toBe("unknown");
    expect(compareLines("x+1=x+2", "1=2")).toBe("unknown"); // no solution: tutor
  });
});

describe("compareLines: expressions", () => {
  it("accepts equal simplifications and catches wrong ones", () => {
    expect(compareLines("2(x+3)+x", "3x+6")).toBe("same");
    expect(compareLines("\\frac{1}{2}+\\frac{1}{3}", "\\frac{5}{6}")).toBe("same");
    expect(compareLines("(x+1)^2", "x^2+2x+1")).toBe("same");
    expect(compareLines("(x+1)^2", "x^2+1")).toBe("different");
    expect(compareLines("\\frac{1}{2}+\\frac{1}{3}", "\\frac{2}{5}")).toBe("different");
    expect(compareLines("3 \\cdot 4 + 2", "14")).toBe("same");
  });
});

describe("isSolutionLine", () => {
  it("spots a finished answer", () => {
    expect(isSolutionLine("x=17")).toBe(true);
    expect(isSolutionLine("-3 = y")).toBe(true);
    expect(isSolutionLine("x = \\frac{3}{4}")).toBe(true);
    expect(isSolutionLine("x+1=5")).toBe(false);
    expect(isSolutionLine("2x=10")).toBe(false);
    expect(isSolutionLine("x+y=5")).toBe(false);
  });
});
