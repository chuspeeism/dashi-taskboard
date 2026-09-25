export function releaseMetadata(packageVersion, releaseTag, stableProductName = "Codex Taskboard") {
  const stableTag = `v${packageVersion}`;
  const betaPrefix = `${stableTag}-beta.`;
  const betaNumber = releaseTag.startsWith(betaPrefix)
    ? releaseTag.slice(betaPrefix.length)
    : "";
  if (releaseTag !== stableTag && betaNumber.match(/^[1-9]\d*/)?.[0] !== betaNumber) {
    throw new Error("Release tag does not match package.json version");
  }

  const prerelease = Boolean(betaNumber);
  const productName = prerelease ? "Codex Taskboard Beta" : stableProductName;
  const prefix = `Codex.Taskboard_${packageVersion}`;
  const linuxDeb = `${prefix}_Ubuntu-24.04-x64.deb`;
  const linuxAppImage = `${prefix}_Ubuntu-24.04-x64.AppImage`;
  const macosUpdater = `${prefix}_universal.app.tar.gz`;
  const assets = {
    dmg: `${prefix}_macOS-universal.dmg`,
    linuxDeb,
    linuxDebSignature: `${linuxDeb}.sig`,
    linuxAppImage,
    linuxAppImageSignature: `${linuxAppImage}.sig`,
    windowsInstaller: `${prefix}_NSIS-x64-unsigned.exe`,
    macosUpdater,
    macosUpdaterSignature: `${macosUpdater}.sig`,
    latest: "latest.json",
  };

  return {
    packageVersion,
    releaseTag,
    releaseVersion: releaseTag.slice(1),
    channel: prerelease ? "beta" : "stable",
    prerelease,
    betaNumber,
    productName,
    appName: `${productName}.app`,
    rawDmgName: `${productName}_${packageVersion}_universal.dmg`,
    buildDmgName: `${prefix}_universal.dmg`,
    assets,
    assetNames: Object.values(assets),
  };
}
