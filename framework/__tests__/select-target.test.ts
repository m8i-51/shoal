import { describe, it, expect } from "vitest";
import { pickMatchingOption } from "../select-target";

describe("pickMatchingOption", () => {
  const options = [
    { label: "Newest first", value: "created_desc" },
    { label: "Oldest first", value: "created_asc" },
    { label: "Name A–Z", value: "name_asc" },
  ];

  it("prefers exact label match", () => {
    expect(pickMatchingOption(options, "Oldest first")?.value).toBe("created_asc");
  });

  it("matches exact option value", () => {
    expect(pickMatchingOption(options, "name_asc")?.label).toBe("Name A–Z");
  });

  it("matches a substring of the option text", () => {
    expect(pickMatchingOption(options, "Newest")?.value).toBe("created_desc");
    expect(pickMatchingOption(options, "A–Z")?.value).toBe("name_asc");
  });

  it("is case-insensitive", () => {
    expect(pickMatchingOption(options, "newest first")?.value).toBe("created_desc");
  });

  it("returns undefined when nothing matches", () => {
    expect(pickMatchingOption(options, "Popularity")).toBeUndefined();
    expect(pickMatchingOption(options, "")).toBeUndefined();
    expect(pickMatchingOption([], "Newest")).toBeUndefined();
  });
});
