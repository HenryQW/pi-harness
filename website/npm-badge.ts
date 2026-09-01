const query = (label: string) =>
  new URLSearchParams({
    cacheSeconds: "7200",
    color: "1d4ed8",
    label,
    labelColor: "6a7282",
    style: "flat-square",
  });

export const npmBadgeUrl = (packageName: string) =>
  `https://img.shields.io/npm/dm/${encodeURIComponent(packageName)}?${query("downloads")}`;

export const licenseBadgeUrl = (packageName: string) =>
  `https://img.shields.io/npm/l/${encodeURIComponent(packageName)}?${query("license")}`;

export const versionBadgeUrl = (version: string) => {
  const params = query("version");
  params.set("message", `v${version}`);
  return `https://img.shields.io/static/v1?${params}`;
};
