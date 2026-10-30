import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ReviewGenerateGuideInput, ReviewGuideInput } from "./review.ts";

const decodeGuideInput = Schema.decodeUnknownSync(ReviewGuideInput);
const encodeGuideInput = Schema.encodeUnknownSync(ReviewGuideInput);
const decodeGenerateInput = Schema.decodeUnknownSync(ReviewGenerateGuideInput);
const encodeGenerateInput = Schema.encodeUnknownSync(ReviewGenerateGuideInput);

describe("local review guide refs", () => {
  it.each(["\u00a0feature\u3000", "refs/remotes/origin/\u3000base\u00a0"])(
    "preserves Unicode whitespace in base ref %j across RPC codecs",
    (baseRef) => {
      const input = { cwd: "/repo", sourceKind: "branch-range", baseRef };
      const decoded = decodeGuideInput(input);
      expect(decoded.baseRef).toBe(baseRef);
      expect(encodeGuideInput(decoded)).toEqual(input);

      const generation = { ...input, projectId: "project-1" };
      const decodedGeneration = decodeGenerateInput(generation);
      expect(decodedGeneration.baseRef).toBe(baseRef);
      expect(encodeGenerateInput(decodedGeneration)).toEqual(generation);
    },
  );
});
