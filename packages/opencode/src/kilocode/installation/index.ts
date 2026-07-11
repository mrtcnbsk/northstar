export const Npm = {
  name: "@ilura/northstar",
  path: "@ilura%2fnorthstar",
}

export const Brew = {
  name: "northstar",
  tap: "mrtcnbsk/tap",
  formula: "mrtcnbsk/tap/northstar",
  api: "https://formulae.brew.sh/api/formula/northstar.json",
}

export const Choco = {
  name: "northstar",
  api: "https://community.chocolatey.org/api/v2/Packages?$filter=Id%20eq%20%27northstar%27%20and%20IsLatestVersion&$select=Version",
}

export const Scoop = {
  name: "northstar",
  manifest: "https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/northstar.json",
}

export const Release = {
  api: "https://api.github.com/repos/mrtcnbsk/northstar/releases/latest",
  install: "https://kilo.ai/cli/install", // kilocode_change - deferred: EPIC 2 hosted domain provisioning
}
