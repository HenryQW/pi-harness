const query = (label: string) =>
  new URLSearchParams({
    cacheSeconds: "7200",
    color: "1d4ed8",
    label,
    labelColor: "101828",
    style: "flat-square",
  });

export const npmBadgeUrl = (packageName: string) =>
  `https://img.shields.io/npm/dm/${encodeURIComponent(packageName)}?${query("downloads")}`;

export const licenseBadgeUrl = (packageName: string) =>
  `https://img.shields.io/npm/l/${encodeURIComponent(packageName)}?${query("license")}`;

export const mitBadgeUrl = () =>
  `https://img.shields.io/badge/license-MIT-1d4ed8?${query("license")}`;
