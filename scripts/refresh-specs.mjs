#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";

const SOURCES = [
  {
    version: "v1",
    url: "https://developers.drata.com/page-data/openapi/reference/v1/overview/page-data.json",
  },
  {
    version: "v2",
    url: "https://developers.drata.com/page-data/openapi/reference/v2/overview/page-data.json",
  },
];

async function extractSpec(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "drata-cli-spec-refresh",
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  const pageData = await response.json();
  const redocStore = JSON.parse(pageData.result.data.contentItem.data.redocStoreStr);
  return redocStore.definition.data;
}

async function main() {
  const specsDir = new URL("../specs/", import.meta.url);
  await mkdir(specsDir, { recursive: true });

  for (const source of SOURCES) {
    const spec = await extractSpec(source.url);
    const outputUrl = new URL(`../specs/${source.version}.json`, import.meta.url);
    await writeFile(outputUrl, `${JSON.stringify(spec, null, 2)}\n`, "utf8");

    const operationCount = Object.values(spec.paths ?? {}).reduce((count, pathItem) => {
      return (
        count +
        Object.keys(pathItem).filter((method) =>
          ["get", "post", "put", "patch", "delete", "head", "options"].includes(method),
        ).length
      );
    }, 0);

    console.log(
      `Wrote specs/${source.version}.json (${Object.keys(spec.paths ?? {}).length} paths, ${operationCount} operations)`,
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
