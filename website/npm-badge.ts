const query = new URLSearchParams({
  color: "1d4ed8",
  label: "downloads",
  labelColor: "101828",
  style: "flat-square",
});

export const npmBadgeUrl = (packageName: string) =>
  `https://img.shields.io/npm/dm/${encodeURIComponent(packageName)}?${query}`;
