#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@opencode-ai/script"
import { fileURLToPath } from "url"
import { NpmPublish } from "./kilocode/npm-publish" // kilocode_change

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

async function publish(dir: string, name: string, version: string) {
  // GitHub artifact downloads can drop the executable bit, and Docker uses the
  // unpacked dist binaries directly rather than the published tarball.
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(dir)
  if (await published(name, version)) {
    console.log(`already published ${name}@${version}`)
    return
  }
  await $`bun pm pack`.cwd(dir)
  // kilocode_change start
  await NpmPublish.retry({
    name,
    version,
    // kilocode_change - dropped --provenance for the FIRST publish: npm provenance tries to verify a
    // repo/package link that does not exist yet for a brand-new package and returns E404. Re-add
    // `--provenance` (supply-chain attestation) once @ilura/northstar exists on npm.
    run: () => $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(dir),
    exists: () => published(name, version),
  })
  // kilocode_change end
}

const binaries: Record<string, string> = {}
// kilocode_change start
for (const filepath of new Bun.Glob("*/*/package.json").scanSync({ cwd: "./dist" })) {
  // kilocode_change end
  const pkg = await Bun.file(`./dist/${filepath}`).json()
  binaries[pkg.name] = pkg.version
}
console.log("binaries", binaries)
const version = Object.values(binaries)[0]

await $`mkdir -p ./dist/${pkg.name}`
await $`cp -r ./bin ./dist/${pkg.name}/bin`
await $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`
await Bun.file(`./dist/${pkg.name}/LICENSE`).write(await Bun.file("../../LICENSE").text())
await Bun.file(`./dist/${pkg.name}/README.md`).write(await Bun.file("./README.md").text()) // kilocode_change

await Bun.file(`./dist/${pkg.name}/package.json`).write(
  JSON.stringify(
    {
      name: pkg.name, // kilocode_change
      bin: {
        // kilocode_change - publish only the northstar bin; the upstream `kilocode` alias was dropped
        // so a global install of @ilura/northstar cannot seize/overwrite upstream Kilo Code's command.
        northstar: `./bin/northstar`,
      },
      scripts: {
        postinstall: "node ./postinstall.mjs",
      },
      version: version,
      license: pkg.license,
      keywords: pkg.keywords, // kilocode_change
      private: pkg.private, // kilocode_change
      os: ["darwin", "linux", "win32"],
      cpu: ["arm64", "x64"],
      optionalDependencies: binaries,
      // kilocode_change start
      repository: {
        type: "git",
        url: "https://github.com/mrtcnbsk/northstar",
      },
      // kilocode_change end
    },
    null,
    2,
  ),
)

const tasks = Object.entries(binaries).map(async ([name]) => {
  await publish(`./dist/${name}`, name, binaries[name])
})
await Promise.all(tasks)
await publish(`./dist/${pkg.name}`, pkg.name, version) // kilocode_change
