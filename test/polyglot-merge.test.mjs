import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkBlocks, mergeBlocks3Way, hashCrossLanguageInterface } from "../src/merge-blocks.mjs";

test("chunkBlocks & mergeBlocks3Way - handles tag-based XML/csproj block merges without conflicts", () => {
  const baseXml = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
  </ItemGroup>
</Project>`;

  const oursXml = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
  </ItemGroup>
</Project>`;

  const theirsXml = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
    <PackageReference Include="Serilog" Version="3.0.0" />
  </ItemGroup>
</Project>`;

  const res = mergeBlocks3Way(baseXml, oursXml, theirsXml, "csproj");
  assert.equal(res.conflicts, 0);
  assert.ok(res.mergedText.includes("<Nullable>enable</Nullable>"));
  assert.ok(res.mergedText.includes("Serilog"));
});

test("chunkBlocks - chunks Python whitespace def/class blocks correctly", () => {
  const pythonCode = `import sys

def foo():
    return 42

class Bar:
    def baz(self):
        pass
`;

  const blocks = chunkBlocks(pythonCode, "python");
  assert.ok(blocks.length >= 2);
  const fooBlock = blocks.find((b) => b.name === "foo");
  assert.ok(fooBlock);
  assert.ok(fooBlock.content.includes("return 42"));
});

test("hashCrossLanguageInterface - computes canonical SHA-256 fingerprint for OpenAPI schemas", () => {
  const schemaA = `{
    "version": "1.0",
    "title": "API",
    "paths": {
      "/users": { "get": { "summary": "Get users" } }
    }
  }`;

  const schemaB = `// OpenAPI comment
  {
    "paths": {
      "/users": { "get": { "summary": "Get users" } }
    },
    "title": "API",
    "version": "1.0"
  }`;

  const hashA = hashCrossLanguageInterface("task-1", "openapi.json", schemaA, "json");
  const hashB = hashCrossLanguageInterface("task-2", "openapi.json", schemaB, "json");

  // Canonical key sorting and comment stripping results in matching SHA-256 hashes
  const shaA = hashA.split(":").pop();
  const shaB = hashB.split(":").pop();
  assert.equal(shaA, shaB);
});
