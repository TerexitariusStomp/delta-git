// Node unit coverage for the workflow yaml → execution-graph parser the
// platform runner drives (src/worker/runner/spec.ts). Pure parsing — no
// workerd bindings needed.

import { describe, expect, it } from "vitest";
import { parseWorkflowSpec } from "../src/worker/runner/spec";

describe("parseWorkflowSpec", () => {
  it("maps GitHub jobs to stages and run steps to commands", () => {
    const spec = parseWorkflowSpec(
      "ci.yml",
      `name: ci
on: push
jobs:
  verify:
    name: verify
    steps:
      - name: install
        run: npm ci
      - name: typecheck
        run: |
          npm run typecheck
          npm run format:check
`
    );
    expect(spec.name).toBe("ci");
    expect(spec.stages).toHaveLength(1);
    expect(spec.stages[0].name).toBe("verify");
    expect(spec.stages[0].steps).toHaveLength(2);
    expect(spec.stages[0].steps[0].commands).toEqual(["npm ci"]);
    expect(spec.stages[0].steps[1].commands[0]).toContain("npm run typecheck");
    expect(spec.stages[0].steps[1].skipped).toBeUndefined();
  });

  it("keeps uses:-only steps as skipped entries", () => {
    const spec = parseWorkflowSpec(
      "ci.yml",
      `jobs:
  build:
    steps:
      - uses: actions/checkout@v4
      - name: test
        run: make test
`
    );
    const steps = spec.stages[0].steps;
    expect(steps).toHaveLength(2);
    expect(steps[0].skipped).toBe(true);
    expect(steps[0].name).toBe("step 1");
    expect(steps[1].skipped).toBeUndefined();
  });

  it("maps multiple jobs to stages in file order", () => {
    const spec = parseWorkflowSpec(
      "ci.yml",
      `jobs:
  build:
    steps:
      - run: make
  test:
    steps:
      - run: make test
`
    );
    expect(spec.stages.map((s) => s.name)).toEqual(["build", "test"]);
  });

  it("parses the Harness stages/steps shape", () => {
    const spec = parseWorkflowSpec(
      "pipe.yml",
      `stages:
  - name: compile
    steps:
      - name: go build
        run: go build ./...
  - name: verify
    steps:
      - name: lint
        script: golangci-lint run
      - name: test
        commands:
          - go test ./pkg/...
          - go test ./cmd/...
`
    );
    expect(spec.stages).toHaveLength(2);
    expect(spec.stages[0].steps[0].commands).toEqual(["go build ./..."]);
    expect(spec.stages[1].steps[0].commands).toEqual(["golangci-lint run"]);
    expect(spec.stages[1].steps[1].commands).toHaveLength(2);
  });

  it("unwraps harness run.spec.command bodies", () => {
    const spec = parseWorkflowSpec(
      "pipe.yml",
      `pipeline:
  stages:
    - name: build
      steps:
        - name: compile
          run:
            spec:
              command: make all
`
    );
    expect(spec.stages[0].steps[0].commands).toEqual(["make all"]);
  });

  it("degrades a bare steps list to a single build stage", () => {
    const spec = parseWorkflowSpec(
      "simple.yml",
      `steps:
  - run: echo hello
`
    );
    expect(spec.stages).toHaveLength(1);
    expect(spec.stages[0].name).toBe("build");
  });

  it("returns empty stages for a yaml with no runnable shape", () => {
    const spec = parseWorkflowSpec("empty.yml", `name: nothing\non: push\n`);
    expect(spec.stages).toEqual([]);
  });
});
