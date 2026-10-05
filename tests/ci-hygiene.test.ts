/**
 * Section 5 of the v1.0.16 review: supply-chain and CI hygiene.
 *
 *  - Actions were pinned by tag (`actions/checkout@v4`). A tag is a mutable ref that the action's
 *    own owner can repoint, so `v4` running yesterday's code is not a guarantee about tomorrow's.
 *    Every `uses:` now names the commit SHA the tag pointed at, with the tag kept as a comment.
 *  - CI ran Node 24 while the Dockerfile builds on Node 22, so the suite verified a toolchain the
 *    released image never uses. CI now runs the version that ships.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const workflow = readFileSync(resolve(ROOT, '.github/workflows/docker-publish.yml'), 'utf8');
const dockerfile = readFileSync(resolve(ROOT, 'Dockerfile'), 'utf8');

/** Every `uses: owner/repo@ref` line in the workflow, with its trailing comment. */
const uses = workflow
  .split('\n')
  .filter((l) => /^\s*uses:/.test(l))
  .map((l) => {
    const m = l.match(/uses:\s*([\w.-]+\/[\w.-]+)@(\S+)/);
    return m ? { action: m[1], ref: m[2], line: l } : null;
  })
  .filter((u): u is { action: string; ref: string; line: string } => u !== null);

describe('the workflow pins every action to a commit', () => {
  it('finds the actions to check', () => {
    expect(uses.length).toBeGreaterThanOrEqual(7);
  });

  it('no action is referenced by a tag or branch', () => {
    for (const u of uses) {
      expect(u.ref, `${u.action} is not pinned to a commit SHA`).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('keeps the human-readable version as a comment, so the pin is auditable', () => {
    // A bare SHA is unauditable: nothing says what version it is. The comment is what lets a
    // maintainer check the pin against upstream, and what Dependabot reads to propose a bump.
    for (const u of uses) {
      expect(u.line, `${u.action} has no version comment`).toMatch(/#\s*v\d/);
    }
  });

  it('never leaves a floating @v4 / @v3 style ref behind', () => {
    expect(workflow).not.toMatch(/uses:\s*[\w.-]+\/[\w.-]+@v\d/);
  });
});

describe('CI tests the toolchain that ships', () => {
  /** The Node major the Dockerfile's build stage uses. */
  const shipped = dockerfile.match(/FROM --platform=\$BUILDPLATFORM node:(\d+)/)?.[1];

  it('the Dockerfile declares one', () => {
    expect(shipped).toBeTruthy();
  });

  it('the workflow uses the same major, so a green run means something for the image', () => {
    const used = workflow.match(/node-version:\s*"?(\d+)"?/)?.[1];
    expect(used).toBe(shipped);
  });
});