#!/usr/bin/env node

import { parseArgs } from "node:util";

const VERSION = "0.1.0";

const HELP = `Issue Fix Agent

Usage:
  issue-fix [options]

Options:
  -h, --help       Show this help message
  -v, --version    Show the installed version

The executable agent command will be introduced in Milestone 0.
`;

function main(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    strict: true,
  });

  if (values["version"] === true) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  process.stdout.write(HELP);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown CLI error";
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 2;
}
